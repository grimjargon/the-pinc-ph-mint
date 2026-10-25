import { getDatabase } from '@netlify/database'
import type { Context } from '@netlify/functions'

const db = getDatabase()
const ADMIN_TOKEN = Netlify.env.get('ADMIN_TOKEN')

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } })
}
function auth(req: Request) {
  if (!ADMIN_TOKEN) return false
  return req.headers.get('x-admin-token') === ADMIN_TOKEN
}
function requireAdmin(req: Request) {
  if (!auth(req)) return json({ error: 'Unauthorized' }, 401)
  return null
}

export default async (req: Request, _context: Context) => {
  try {
    if (req.method === 'GET') {
      const u = new URL(req.url)
      const action = u.searchParams.get('action') || 'products'
      if (action === 'products') {
        const rows = await db.sql`SELECT id,name,price,category,description,stock,active,created_at,updated_at FROM products ORDER BY category,name`
        return json(rows)
      }
      if (action === 'status') {
        const orderNo = u.searchParams.get('order_no')
        if (!orderNo) return json({ error: 'Order number required' }, 400)
        const rows = await db.sql`SELECT order_no,customer_name,delivery,address,items,subtotal,discount,total,status,payment_confirmed,created_at,updated_at FROM orders WHERE order_no=${orderNo}`
        if (!rows.length) return json({ error: 'Order not found' }, 404)
        const order = rows[0]
        const reviews = await db.sql`SELECT product_id,rating,review_text,approved,created_at FROM reviews WHERE order_no=${orderNo}`
        return json({ order, reviews })
      }
      if (!auth(req)) return json({ error: 'Unauthorized' }, 401)
      if (action === 'orders') {
        const rows = await db.sql`SELECT * FROM orders ORDER BY created_at DESC LIMIT 500`
        return json(rows)
      }
      if (action === 'promos') return json(await db.sql`SELECT * FROM promos ORDER BY created_at DESC`)
      if (action === 'reviews') return json(await db.sql`SELECT r.*,p.name AS product_name FROM reviews r JOIN products p ON p.id=r.product_id ORDER BY r.created_at DESC`)
      if (action === 'report') {
        const days = Math.min(Math.max(Number(u.searchParams.get('days') || 30), 1), 365)
        const summary = await db.sql`SELECT COUNT(*)::int AS orders, COALESCE(SUM(total),0)::int AS sales, COALESCE(SUM(discount),0)::int AS discounts FROM orders WHERE status <> 'Cancelled' AND created_at >= NOW() - (${days} || ' days')::interval`
        const best = await db.sql`SELECT item->>'name' AS product, SUM((item->>'qty')::int)::int AS units, SUM(((item->>'qty')::int)*(item->>'unit_price')::int)::int AS gross FROM orders o, jsonb_array_elements(o.items) item WHERE o.status <> 'Cancelled' AND o.created_at >= NOW() - (${days} || ' days')::interval GROUP BY 1 ORDER BY units DESC LIMIT 20`
        const byDate = await db.sql`SELECT DATE(created_at) AS day, COUNT(*)::int AS orders, COALESCE(SUM(total),0)::int AS sales FROM orders WHERE status <> 'Cancelled' AND created_at >= NOW() - (${days} || ' days')::interval GROUP BY 1 ORDER BY 1 DESC`
        return json({ summary: summary[0], best, byDate })
      }
      return json({ error: 'Unknown action' }, 400)
    }

    const body = await req.json()
    const action = body.action

    if (action === 'create_order') {
      const o = body.order
      if (!o?.order_no || !o.customer_name || !o.mobile || !o.email || !o.address || !Array.isArray(o.items) || !o.items.length) return json({ error: 'Invalid order' }, 400)
      const ids = o.items.map((x: any) => x.product_id)
      const products = await db.sql`SELECT id,name,price,stock,active FROM products WHERE id = ANY(${ids})`
      const byId = new Map(products.map((p: any) => [p.id, p]))
      let subtotal = 0
      for (const item of o.items) {
        const p = byId.get(item.product_id)
        if (!p || !p.active) return json({ error: `Product unavailable: ${item.name}` }, 409)
        subtotal += Number(p.price) * Number(item.qty)
      }
      await db.sql`INSERT INTO orders (order_no,customer_name,mobile,email,delivery,address,notes,items,subtotal,total) VALUES (${o.order_no},${o.customer_name},${o.mobile},${o.email},${o.delivery},${o.address},${o.notes||''},${JSON.stringify(o.items)},${subtotal},${subtotal})`
      return json({ ok: true, order_no: o.order_no }, 201)
    }

    const denied = requireAdmin(req); if (denied) return denied

    if (action === 'update_product') {
      const p = body.product
      await db.sql`UPDATE products SET name=${p.name},price=${Number(p.price)},category=${p.category},description=${p.description||''},stock=${p.stock===null||p.stock===''?null:Number(p.stock)},active=${p.active!==false},updated_at=NOW() WHERE id=${p.id}`
      return json({ ok: true })
    }
    if (action === 'create_product') {
      const p = body.product
      await db.sql`INSERT INTO products (id,name,price,category,description,stock,active) VALUES (${p.id},${p.name},${Number(p.price)},${p.category},${p.description||''},${p.stock===null||p.stock===''?null:Number(p.stock)},${p.active!==false})`
      return json({ ok: true }, 201)
    }
    if (action === 'update_order') {
      const { order_no, status, payment_confirmed } = body
      const current = await db.sql`SELECT * FROM orders WHERE order_no=${order_no}`
      if (!current.length) return json({ error: 'Order not found' }, 404)
      const o:any=current[0]
      const confirming = payment_confirmed === true && !o.payment_confirmed
      if (confirming) {
        const client = await db.pool.connect()
        try {
          await client.query('BEGIN')
          for (const item of o.items) {
            const r = await client.query('UPDATE products SET stock=stock-$1,updated_at=NOW() WHERE id=$2 AND stock IS NOT NULL AND stock >= $1 RETURNING id', [Number(item.qty), item.product_id])
            if (r.rowCount === 0) {
              const p = await client.query('SELECT stock FROM products WHERE id=$1', [item.product_id])
              if (p.rows[0]?.stock !== null) throw new Error(`Insufficient stock for ${item.name}`)
            }
          }
          await client.query('UPDATE orders SET payment_confirmed=true,status=$1,updated_at=NOW() WHERE order_no=$2', ['Payment Confirmed',order_no])
          await client.query('COMMIT')
        } catch(e) { await client.query('ROLLBACK'); return json({error:e instanceof Error?e.message:'Payment confirmation failed'},409) } finally { client.release() }
      } else {
        await db.sql`UPDATE orders SET status=${status || o.status},payment_confirmed=${payment_confirmed ?? o.payment_confirmed},updated_at=NOW() WHERE order_no=${order_no}`
      }
      return json({ ok: true })
    }
    if (action === 'create_promo') {
      const p=body.promo
      await db.sql`INSERT INTO promos (code,discount_type,amount,active) VALUES (${String(p.code).trim().toUpperCase()},${p.discount_type},${Number(p.amount)},${p.active!==false}) ON CONFLICT(code) DO UPDATE SET discount_type=EXCLUDED.discount_type,amount=EXCLUDED.amount,active=EXCLUDED.active`
      return json({ok:true})
    }
    if (action === 'delete_promo') { await db.sql`DELETE FROM promos WHERE id=${Number(body.id)}`; return json({ok:true}) }
    if (action === 'approve_review') { await db.sql`UPDATE reviews SET approved=${!!body.approved} WHERE id=${Number(body.id)}`; return json({ok:true}) }
    if (action === 'create_review') {
      const {order_no,product_id,rating,review_text}=body
      const o=await db.sql`SELECT status,items FROM orders WHERE order_no=${order_no}`
      if(!o.length||o[0].status!=='Delivered') return json({error:'Reviews unlock after the order is Delivered.'},409)
      const purchased=o[0].items.some((x:any)=>x.product_id===product_id)
      if(!purchased) return json({error:'Product was not purchased in this order.'},403)
      await db.sql`INSERT INTO reviews(order_no,product_id,rating,review_text,approved) VALUES(${order_no},${product_id},${Number(rating)},${review_text||''},FALSE)`
      return json({ok:true},201)
    }
    return json({error:'Unknown action'},400)
  } catch (e) {
    console.error(e)
    return json({ error: e instanceof Error ? e.message : 'Server error' }, 500)
  }
}
