import { createHash } from 'node:crypto'
import { getDatabase } from '@netlify/database'
import type { Context } from '@netlify/functions'

const db = getDatabase()
const ADMIN_USER = 'admin'
const ADMIN_PASSWORD_SHA256 = 'a1679096d0dd1af75e3ed623def0b33a3f6f5339b016588f9ae1e5f9f44628fb'

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } })
}

function authorized(req: Request) {
  const h = req.headers.get('authorization') || ''
  if (!h.startsWith('Basic ')) return false
  try {
    const raw = Buffer.from(h.slice(6), 'base64').toString('utf8')
    const i = raw.indexOf(':')
    if (i <= 0 || raw.slice(0, i) !== ADMIN_USER) return false
    const passwordHash = createHash('sha256').update(raw.slice(i + 1)).digest('hex')
    return passwordHash === ADMIN_PASSWORD_SHA256
  } catch {
    return false
  }
}

async function ensureSchema() {
  await db.sql`CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', stock INTEGER NULL, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  await db.sql`CREATE TABLE IF NOT EXISTS orders (id BIGSERIAL PRIMARY KEY, order_no TEXT UNIQUE NOT NULL, customer_name TEXT NOT NULL, mobile TEXT NOT NULL, email TEXT NOT NULL, delivery TEXT NOT NULL, address TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', items JSONB NOT NULL, subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'Unpaid / Unconfirmed', payment_confirmed BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  await db.sql`CREATE TABLE IF NOT EXISTS promos (id BIGSERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, discount_type TEXT NOT NULL, amount INTEGER NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  await db.sql`CREATE TABLE IF NOT EXISTS reviews (id BIGSERIAL PRIMARY KEY, order_no TEXT NOT NULL, product_id TEXT NOT NULL REFERENCES products(id), rating INTEGER NOT NULL, review_text TEXT NOT NULL DEFAULT '', approved BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
}

async function ensureCatalog() {
  const existing = await db.sql`SELECT COUNT(*)::int AS count FROM products`
  if (Number(existing[0]?.count || 0) > 0) return
  const r = await fetch('https://raw.githubusercontent.com/grimjargon/the-pinc-ph-mint/main/index.html', { cache: 'no-store' })
  if (!r.ok) throw new Error('Catalog source unavailable')
  const html = await r.text()
  const m = html.match(/const products=(\[.*?\]);/)
  if (!m) throw new Error('Catalog not found')
  const catalog = JSON.parse(m[1])
  for (const p of catalog) await db.sql`INSERT INTO products (id,name,price,category,description,stock,active) VALUES (${p.id},${p.name},${Number(p.price)},${p.category},${p.desc || ''},NULL,TRUE) ON CONFLICT (id) DO NOTHING`
}

export default async (req: Request, _context: Context) => {
  try {
    if (!authorized(req)) return json({ error: 'Invalid username or password.' }, 401)
    await ensureSchema()
    await ensureCatalog()
    const u = new URL(req.url)
    if (req.method === 'GET') {
      const action = u.searchParams.get('action') || 'products'
      if (action === 'products') return json(await db.sql`SELECT id,name,price,category,description,stock,active,created_at,updated_at FROM products ORDER BY category,name`)
      if (action === 'orders') return json(await db.sql`SELECT * FROM orders ORDER BY created_at DESC LIMIT 500`)
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
      const o: any = current[0]
      if (payment_confirmed === true && !o.payment_confirmed) {
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
          await client.query('UPDATE orders SET payment_confirmed=true,status=$1,updated_at=NOW() WHERE order_no=$2', ['Payment Confirmed', order_no])
          await client.query('COMMIT')
        } catch (e) {
          await client.query('ROLLBACK')
          return json({ error: e instanceof Error ? e.message : 'Payment confirmation failed' }, 409)
        } finally { client.release() }
      } else {
        await db.sql`UPDATE orders SET status=${status||o.status},payment_confirmed=${payment_confirmed??o.payment_confirmed},updated_at=NOW() WHERE order_no=${order_no}`
      }
      return json({ ok: true })
    }
    if (action === 'create_promo') {
      const p = body.promo
      await db.sql`INSERT INTO promos (code,discount_type,amount,active) VALUES (${String(p.code).trim().toUpperCase()},${p.discount_type},${Number(p.amount)},${p.active!==false}) ON CONFLICT(code) DO UPDATE SET discount_type=EXCLUDED.discount_type,amount=EXCLUDED.amount,active=EXCLUDED.active`
      return json({ ok: true })
    }
    if (action === 'delete_promo') {
      await db.sql`DELETE FROM promos WHERE id=${Number(body.id)}`
      return json({ ok: true })
    }
    if (action === 'approve_review') {
      await db.sql`UPDATE reviews SET approved=${!!body.approved} WHERE id=${Number(body.id)}`
      return json({ ok: true })
    }
    return json({ error: 'Unknown action' }, 400)
  } catch (e) {
    console.error(e)
    return json({ error: e instanceof Error ? e.message : 'Server error' }, 500)
  }
}
