import { get, put } from '@vercel/blob';
import crypto from 'node:crypto';

const DB_PATH = 'pinc-ph-mint.json';
const ADMIN_HASH = '3f3e8245747b1ca6c78ef4808864577dec900b34e06cce38001dfdde163e2b5a';

const SEED_PRODUCTS = [
  ['t15','Tirzepatide 15 mg',1499,'Weight Management','15 mg vial'],
  ['t30','Tirzepatide 30 mg',1699,'Weight Management','30 mg vial'],
  ['t60','Tirzepatide 60 mg',2099,'Weight Management','60 mg vial'],
  ['r10','Retatrutide 10 mg',1199,'Weight Management','10 mg vial'],
  ['r15','Retatrutide 15 mg',1499,'Weight Management','15 mg vial'],
  ['c5','Cagrilintide 5 mg',1199,'Weight Management','5 mg vial'],
  ['e5','Eloralintide 5 mg',1799,'Weight Management','5 mg vial'],
  ['rc10','Reta + Cagri (10 mg)',1699,'Weight Management','Combination vial'],
  ['semax','Semax 10 mg',999,'Cognitive & Sleep','10 mg vial'],
  ['selank','Selank 10 mg',999,'Cognitive & Sleep','10 mg vial'],
  ['selsmx','Selank + Semax 10 mg',1099,'Cognitive & Sleep','Combination vial'],
  ['dsip','DSIP 10 mg',1099,'Cognitive & Sleep','10 mg vial'],
  ['aod','AOD ProMax 5 mg',1199,'Fat Loss & Metabolic Enhancement','5 mg vial'],
  ['amino1mq','5-Amino 1MQ 50 mg',1199,'Fat Loss & Metabolic Enhancement','50 mg vial'],
  ['lemon','Lemon Bottle 10 mL',950,'Fat Loss & Metabolic Enhancement','10 mL'],
  ['ghk50','GHK-Cu 50 mg',899,'Energy, Tissue Repair, Healing, Skin Regeneration','50 mg vial'],
  ['klow','KLOW 80 mg',1799,'Energy, Tissue Repair, Healing, Skin Regeneration','80 mg blend'],
  ['ghkkpv','GHK-KPV 60 mg',1299,'Energy, Tissue Repair, Healing, Skin Regeneration','60 mg blend']
].map(([id,name,price,category,description]) => ({id,name,price,category,description,stock:null,active:true}));

function response(body, status=200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
}

function authorized(request) {
  const h = request.headers.get('authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  let raw = '';
  try { raw = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return hash === ADMIN_HASH;
}

function adminRequired(request) {
  if (!authorized(request)) return response({error:'Unauthorized'}, 401);
  return null;
}

async function readDb() {
  const result = await get(DB_PATH, { access:'private', useCache:false });
  if (!result || result.statusCode !== 200) {
    return { products: SEED_PRODUCTS, orders: [], promos: [], reviews: [] };
  }
  const text = await new Response(result.stream).text();
  try { return JSON.parse(text); } catch { return { products: SEED_PRODUCTS, orders: [], promos: [], reviews: [] }; }
}

async function writeDb(db) {
  await put(DB_PATH, JSON.stringify(db), { access:'private', addRandomSuffix:false, allowOverwrite:true, contentType:'application/json', cacheControlMaxAge:0 });
}

function summary(db) {
  const paid = db.orders.filter(o => ['Payment Confirmed','Pending','Processing','Shipped','Delivered'].includes(o.status));
  const sales = paid.reduce((n,o)=>n+Number(o.total||0),0);
  const days = {};
  for (const o of paid) {
    const day = String(o.created_at||'').slice(0,10) || new Date().toISOString().slice(0,10);
    days[day] ||= {day,orders:0,sales:0}; days[day].orders++; days[day].sales += Number(o.total||0);
  }
  return { summary:{orders:db.orders.length,sales}, byDate:Object.values(days).sort((a,b)=>a.day.localeCompare(b.day)).slice(-30) };
}

export default async function handler(request) {
  try {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (method === 'OPTIONS') return new Response(null,{status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type,authorization'}});

    const action = method === 'GET' ? (url.searchParams.get('action') || 'products') : ((await request.json()).action || '');
    const needsAdmin = !['products','create_order'].includes(action);
    if (needsAdmin) { const denied = adminRequired(request); if (denied) return denied; }

    const db = await readDb();
    if (action === 'products') return response({products:db.products});
    if (action === 'orders') return response({orders:db.orders});
    if (action === 'promos') return response({promos:db.promos});
    if (action === 'reviews') return response({reviews:db.reviews});
    if (action === 'report') return response(summary(db));

    if (action === 'create_order') {
      const body = await request.clone().json();
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return response({error:'Cart is empty'},400);
      const products = items.map(i => db.products.find(p=>p.id===i.id)).filter(Boolean);
      if (products.length !== items.length) return response({error:'One or more products are unavailable'},400);
      const total = items.reduce((n,i)=>{ const p=db.products.find(x=>x.id===i.id); return n + Number(p.price)*Math.max(1,Number(i.qty||1)); },0);
      const order = { order_no:'PXM-'+Date.now().toString(36).toUpperCase(), customer_name:body.customer_name||'', mobile:body.mobile||'', email:body.email||'', address:body.address||'', delivery:body.delivery||'', notes:body.notes||'', items, total, status:'Unpaid / Unconfirmed', payment_confirmed:false, created_at:new Date().toISOString() };
      db.orders.push(order); await writeDb(db); return response({order});
    }

    const body = method === 'GET' ? {} : await request.clone().json();
    if (action === 'update_product') {
      const incoming = body.product || {};
      const i = db.products.findIndex(p=>p.id===incoming.id);
      if (i<0) return response({error:'Product not found'},404);
      db.products[i] = {...db.products[i], ...incoming, price:Number(incoming.price), stock:incoming.stock===''||incoming.stock==null?null:Number(incoming.stock), active:Boolean(incoming.active)};
      await writeDb(db); return response({product:db.products[i]});
    }
    if (action === 'create_product') {
      const p = body.product || {}; if (!p.id||!p.name) return response({error:'id and name are required'},400);
      if (db.products.some(x=>x.id===p.id)) return response({error:'Product id already exists'},409);
      const product={id:String(p.id),name:String(p.name),price:Number(p.price||0),category:String(p.category||'Other'),description:String(p.description||''),stock:p.stock===''||p.stock==null?null:Number(p.stock),active:p.active!==false};
      db.products.push(product); await writeDb(db); return response({product});
    }
    if (action === 'update_order') {
      const i=db.orders.findIndex(o=>o.order_no===body.order_no); if(i<0)return response({error:'Order not found'},404);
      const o=db.orders[i];
      if(body.payment_confirmed===true && !o.payment_confirmed){
        for(const item of o.items||[]){ const p=db.products.find(x=>x.id===item.id); if(p && p.stock!==null && Number(p.stock)<Number(item.qty||1)) return response({error:`Insufficient stock for ${p.name}`},409); }
        for(const item of o.items||[]){ const p=db.products.find(x=>x.id===item.id); if(p && p.stock!==null) p.stock=Number(p.stock)-Number(item.qty||1); }
        o.payment_confirmed=true; o.status='Payment Confirmed'; o.paid_at=new Date().toISOString();
      }
      if(body.status) o.status=String(body.status);
      await writeDb(db); return response({order:o});
    }
    if (action === 'create_promo') { db.promos.push({...body.promo,active:true,created_at:new Date().toISOString()}); await writeDb(db); return response({promos:db.promos}); }
    if (action === 'delete_promo') { db.promos=db.promos.filter(p=>p.code!==body.code); await writeDb(db); return response({promos:db.promos}); }
    if (action === 'approve_review') { const r=db.reviews.find(x=>Number(x.id)===Number(body.id)); if(!r)return response({error:'Review not found'},404); r.approved=Boolean(body.approved); await writeDb(db); return response({review:r}); }
    return response({error:'Unknown action'},400);
  } catch (error) {
    console.error(error);
    return response({error:error?.message || 'Server error'},500);
  }
}
