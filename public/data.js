(()=>{
if(window.babasStartupRunning)return;
window.babasStartupRunning=true;
// Keep the four-second welcome independent of menu/network availability.
const intro=document.getElementById('welcome-intro');
if(intro&&!window.babasWelcomeStarted){
 window.babasWelcomeStarted=true;
 document.documentElement.classList.add('intro-open');
 const sections=[...document.querySelectorAll('header,main,footer')];sections.forEach(el=>el.inert=true);
 setTimeout(()=>{if(intro.isConnected){intro.classList.add('leaving');document.documentElement.classList.remove('intro-open');sections.forEach(el=>el.inert=false);setTimeout(()=>intro.remove(),600)}},4000);
}
function notice(text){
 if(document.getElementById('startup-status'))return;
 const box=document.createElement('div');box.id='startup-status';box.setAttribute('role','status');box.style.cssText='margin:12px auto;padding:10px 16px;max-width:860px;display:flex;align-items:center;justify-content:center;gap:12px;color:#e8e5d7;font-size:13px;text-align:center';
 const message=document.createElement('span');message.textContent=text;const retry=document.createElement('button');retry.type='button';retry.textContent='Retry';retry.style.cssText='padding:6px 14px;border:1px solid #f16b4b;border-radius:20px;background:transparent;color:#f16b4b;cursor:pointer';retry.onclick=()=>location.reload();box.append(message,retry);document.querySelector('header')?.after(box);
}
async function fetchMenu(url){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000);
 try{const response=await fetch(url,{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('Unavailable');const data=await response.json();if(!data||!data.details||!Array.isArray(data.menu)||!Array.isArray(data.bar))throw Error('Invalid menu');return data}finally{clearTimeout(timer)}
}
function loadScript(name,version,onload){
 if(document.querySelector('script[data-babas-module="'+name+'"]'))return;
 const script=document.createElement('script');script.dataset.babasModule=name;script.src=name+'?v='+version;if(onload)script.onload=onload;script.onerror=()=>notice('Some features could not load. Retry to continue.');document.body.append(script);
}
async function start(){
let data;try{data=await fetchMenu('/api/site')}catch{try{data=await fetchMenu('menu-data.json');notice('You are viewing the saved menu. Retry for the latest details.')}catch{notice('The latest menu could not load. Retry to continue.')}}
const money=p=>p!==''?'₹'+Number(p).toLocaleString('en-IN'):'';
window.babasData=data;
if(data){
 const details=data.details;document.querySelector('.hero-copy .eyebrow').lastChild.textContent=' '+details.tagline;document.querySelector('.hero-copy .intro').textContent=details.intro;document.querySelector('footer p').textContent=details.footer;
 const grid=document.querySelector('.menu-grid');grid.replaceChildren();
 data.menu.filter(x=>x.available).forEach((item,i)=>{
  const card=document.createElement('article');card.className='dish';card.dataset.category=item.category;
  card.innerHTML='<div class="dish-image"><img><span class="dish-index"></span></div><div class="dish-body"><span class="category"></span><h3></h3><p></p><div class="dish-bottom"><span class="menu-price"></span><button class="dish-more">Explore dish ↗</button></div></div>';
  const img=card.querySelector('img');img.src=item.image;img.alt=item.name;
  card.querySelector('.dish-index').textContent=String(i+1).padStart(2,'0');card.querySelector('.category').textContent=item.label;card.querySelector('h3').textContent=item.name;card.querySelector('p').textContent=item.description;card.querySelector('.menu-price').textContent=money(item.price);
  const button=card.querySelector('button');button.dataset.title=item.name;button.dataset.description=item.description+(item.price?' · '+money(item.price):'');grid.append(card);
 });
 const bars=[...document.querySelectorAll('.pour-card')];data.bar.forEach(item=>{const card=bars[Number(item.id)-1];if(!card)return;card.dataset.unavailable=String(!item.available);card.dataset.name=item.name.toLowerCase();card.querySelector('h3').textContent=item.name;const button=card.querySelector('.pour-details');button.dataset.title=item.name;button.dataset.description=item.description;const starting=card.querySelector('.pour-status');starting.textContent=item.price?'Starting from '+money(item.price):'Discover the category';starting.classList.toggle('has-starting-price',Boolean(item.price));card.querySelector('h3').after(starting);const description=document.createElement('p');description.className='pour-description';description.textContent=item.description;description.hidden=!item.description;starting.after(description);});
 const contact=document.createElement('div');contact.className='restaurant-details';[details.address,details.hours].filter(Boolean).forEach(value=>{const p=document.createElement('p');p.textContent=value;contact.append(p)});if(contact.childElementCount)document.querySelector('footer').before(contact);
}
}
start().catch(()=>notice('Some menu details could not load. Retry to continue.')).finally(()=>{
 loadScript('app.js',10,()=>{loadScript('shop.js',14);loadScript('catalogue.js',12,()=>loadScript('creative.js',1))});
});
})();
