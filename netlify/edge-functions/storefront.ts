export default async (request: Request, context: any) => {
  const response = await context.next()
  const contentType = response.headers.get('content-type') || ''
  const url = new URL(request.url)
  if (url.pathname !== '/' || !contentType.includes('text/html')) return response
  let html = await response.text()
  const injected = `<script>(function(){
const originalAdd=EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener=function(type,handler,opts){
  if(this && this.id==='form' && type==='submit'){
    return originalAdd.call(this,type,async function(e){
      e.preventDefault();
      const form=this;
      const cart=JSON.parse(localStorage.getItem('pxm_cart')||'{}');
      if(!Object.keys(cart).length){alert('Your cart is empty.');return}
      const v=id=>document.getElementById(id)?.value||'';
      const r=await fetch('/api/store?action=products',{cache:'no-store'});
      const ps=await r.json();
      const items=ps.filter(p=>cart[p.id]).map(p=>({product_id:p.id,name:p.name,qty:Number(cart[p.id]),unit_price:Number(p.price)}));
      const total=items.reduce((s,x)=>s+x.qty*x.unit_price,0);
      const d=new Date(), no='PXM-'+d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0')+'-'+Math.random().toString(36).slice(2,7).toUpperCase();
      const order={order_no:no,customer_name:v('name'),mobile:v('mobile'),email:v('email'),delivery:v('delivery'),address:v('address'),notes:v('notes'),items,total};
      try{
        const save=await fetch('/api/store',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'create_order',order})});
        const data=await save.json();
        if(!save.ok) throw new Error(data.error||'Could not save order');
        const lines=items.map(x=>x.name+' × '+x.qty+' = ₱'+(x.qty*x.unit_price).toLocaleString('en-PH')).join('\\n');
        const text='ORDER '+no+'\\n\\nCustomer: '+order.customer_name+'\\nMobile/WhatsApp: '+order.mobile+'\\nEmail: '+order.email+'\\nDelivery: '+order.delivery+'\\nAddress: '+order.address+'\\n\\nITEMS\\n'+lines+'\\n\\nTOTAL: ₱'+total.toLocaleString('en-PH')+'\\nNotes: '+(order.notes||'None');
        const box=document.getElementById('orderText'); if(box) box.textContent=text;
        const wa=document.getElementById('wa'); if(wa) wa.href='https://wa.me/6391786028053?text='+encodeURIComponent(text);
        form.classList.add('hidden'); document.getElementById('result')?.classList.remove('hidden');
        localStorage.removeItem('pxm_cart');
      }catch(err){alert(err.message||'We could not save the order. Please try again.')}
    },opts);
  }
  return originalAdd.call(this,type,handler,opts)
};

function renderVialAddons(){
  const ps=window.products||[];
  const cart=JSON.parse(localStorage.getItem('pxm_cart')||'{}');
  const vial=ps.some(p=>cart[p.id] && /vial|combination/i.test((p.name||'')+' '+(p.desc||'')));
  let box=document.getElementById('addonBox');
  const itemsEl=document.getElementById('cartItems');
  if(!itemsEl) return;
  if(!box){box=document.createElement('div');box.id='addonBox';itemsEl.insertAdjacentElement('afterend',box)}
  if(!vial){box.innerHTML='';return}
  const diluents=ps.filter(p=>p.category==='Diluents & Water');
  const sets=ps.filter(p=>p.category==='Sets & Upgrades');
  const group=(title,items)=>"<div style=\"margin-top:12px\"><strong style=\"display:block;font-size:12px;color:#f5c5df;margin-bottom:7px\">"+title+"</strong>"+items.map(p=>"<div style=\"display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;border:1px solid #50344d;border-radius:11px;background:#1b1023;margin-top:7px\"><span style=\"font-size:12px\">"+p.name+"<br><small>₱"+Number(p.price).toLocaleString('en-PH')+"</small></span><button class=\"btn secondary\" style=\"padding:7px 10px;border-radius:9px;font-size:11px\" onclick=\"addVialAddon('"+p.id+"')\">Add to cart</button></div>").join('')+"</div>";
  box.innerHTML='<div style="margin-top:18px;border:1px solid #68405f;background:#24152d;border-radius:16px;padding:15px"><h3 style="margin:0 0 5px;font-size:16px">Complete your order</h3><p style="margin:0 0 12px;color:#cdbdd3;font-size:12px;line-height:1.45">Your cart contains a vial. Would you like to add a diluent or set? Optional — nothing is added unless you choose it.</p>'+group('Diluents & Water',diluents)+group('Sets & Upgrades',sets)+'</div>';
}

window.addVialAddon=function(id){
  const cart=JSON.parse(localStorage.getItem('pxm_cart')||'{}');
  cart[id]=(cart[id]||0)+1;
  localStorage.setItem('pxm_cart',JSON.stringify(cart));
  if(typeof window.save==='function') window.save();
  if(typeof window.openCart==='function') window.openCart();
  setTimeout(renderVialAddons,0);
};

window.addEventListener('DOMContentLoaded',function(){
  setTimeout(function(){
    if(typeof window.openCart==='function' && !window.openCart.__vialAddonWrapped){
      const originalOpenCart=window.openCart;
      const wrapped=function(){originalOpenCart();setTimeout(renderVialAddons,0)};
      wrapped.__vialAddonWrapped=true;
      window.openCart=wrapped;
    }
    renderVialAddons();
  },0);
});
})();</script>`
  html = html.replace('</head>', injected + '</head>')
  return new Response(html,{status:response.status,headers:response.headers})
}
