(()=>{
if(window.babasAppInitialized)return;
window.babasAppInitialized=true;
const welcomeIntro=document.getElementById('welcome-intro');
if(welcomeIntro&&!window.babasWelcomeStarted){
 window.babasWelcomeStarted=true;
 document.documentElement.classList.add('intro-open');
 const pageSections=[...document.querySelectorAll('header,main,footer')];pageSections.forEach(e=>e.inert=true);
 setTimeout(()=>{welcomeIntro.classList.add('leaving');document.documentElement.classList.remove('intro-open');pageSections.forEach(e=>e.inert=false);setTimeout(()=>welcomeIntro.remove(),600)},4000);
}
const motionPreference=matchMedia('(prefers-reduced-motion: reduce)');
const scene=document.querySelector('.scene'),hero=document.querySelector('.hero');
let paused=motionPreference.matches,active=false,raf=0,targetX=0,targetY=0,currentX=0,currentY=0;
const motionButton=document.createElement('button');motionButton.className='motion-control';motionButton.type='button';scene.append(motionButton);
function updateControl(){motionButton.textContent=paused?'Enable motion ↗':'Pause motion Ⅱ';motionButton.setAttribute('aria-pressed',String(paused));motionButton.setAttribute('aria-label',paused?'Enable cursor animation':'Pause cursor animation');scene.classList.toggle('paused',paused)}updateControl();
function renderMotion(){raf=0;if(paused)return;currentX+=(targetX-currentX)*.075;currentY+=(targetY-currentY)*.075;scene.style.setProperty('--rx',`${-currentY*11}deg`);scene.style.setProperty('--ry',`${currentX*17}deg`);scene.style.setProperty('--mx',`${currentX*19}px`);scene.style.setProperty('--my',`${currentY*13}px`);if(active||Math.abs(targetX-currentX)+Math.abs(targetY-currentY)>.002)raf=requestAnimationFrame(renderMotion)}
function startMotion(){if(!raf&&!paused)raf=requestAnimationFrame(renderMotion)}
hero.addEventListener('pointermove',e=>{if(e.pointerType==='touch'||paused)return;const r=hero.getBoundingClientRect();targetX=Math.max(-1,Math.min(1,(e.clientX-r.left)/r.width*2-1));targetY=Math.max(-1,Math.min(1,(e.clientY-r.top)/r.height*2-1));active=true;startMotion()});
hero.addEventListener('pointerleave',()=>{active=false;targetX=targetY=0;startMotion()});
motionButton.addEventListener('click',()=>{paused=!paused;updateControl();if(paused){cancelAnimationFrame(raf);raf=0;document.querySelectorAll('.dish,.pour-card').forEach(c=>{c.style.transform='';c.style.setProperty('--px','0px');c.style.setProperty('--py','0px')})}else{currentX=currentY=0;startMotion()}});
motionPreference.addEventListener('change',e=>{paused=e.matches;updateControl();if(paused){cancelAnimationFrame(raf);raf=0}else startMotion()});
document.querySelectorAll('.dish').forEach(card=>{card.addEventListener('pointermove',e=>{if(e.pointerType==='touch'||paused)return;const r=card.getBoundingClientRect();card.style.transform=`perspective(900px) rotateX(${-(e.clientY-r.top-r.height/2)/25}deg) rotateY(${(e.clientX-r.left-r.width/2)/25}deg) translateY(-4px)`});card.addEventListener('pointerleave',()=>card.style.transform='')});
document.querySelectorAll('.filters button').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.filters button').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',String(x===b))});document.querySelectorAll('.dish').forEach(d=>d.hidden=b.dataset.filter!=='all'&&d.dataset.category!==b.dataset.filter)}));
const modal=document.querySelector('dialog');document.querySelectorAll('.dish-more').forEach(b=>b.addEventListener('click',()=>{modal.querySelector('h2').textContent=b.dataset.title;modal.querySelector('.description').textContent=b.dataset.description;modal.showModal()}));document.querySelectorAll('.close,.close-bottom').forEach(b=>b.addEventListener('click',()=>modal.close()));modal.addEventListener('click',e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)modal.close()}});
let barFilter='All pours';const barSearch=document.querySelector('.bar-search input');const pourCards=[...document.querySelectorAll('.pour-card')];
function updateBar(){const q=barSearch.value.trim().toLowerCase();let count=0;pourCards.forEach(c=>{const show=c.dataset.unavailable!=='true'&&(barFilter==='All pours'||c.dataset.group===barFilter)&&(c.dataset.name+' '+c.dataset.group.toLowerCase()).includes(q);c.hidden=!show;if(show)count++});document.querySelector('.bar-count').textContent=`${count} of ${pourCards.length} categories`;document.querySelector('.bar-empty').hidden=count>0}
document.querySelectorAll('[data-bar-filter]').forEach(b=>b.addEventListener('click',()=>{barFilter=b.dataset.barFilter;document.querySelectorAll('[data-bar-filter]').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',String(x===b))});updateBar()}));barSearch.addEventListener('input',updateBar);updateBar();
document.querySelectorAll('.pour-details').forEach(b=>b.addEventListener('click',()=>{modal.querySelector('h2').textContent=b.dataset.title;modal.querySelector('.description').textContent=b.dataset.description||`${b.dataset.title} is part of the planned ${b.dataset.group.toLowerCase()} collection at Baba's Bar & Restro. The final brands, serving sizes, stock and restaurant prices are yet to be confirmed. Browse the categories now; the complete bar menu will follow.`;modal.showModal()}));
const dialogPhoto=document.createElement('img');dialogPhoto.className='dialog-photo';dialogPhoto.hidden=true;modal.insertBefore(dialogPhoto,modal.querySelector('.eyebrow'));
document.querySelectorAll('.dish-more').forEach(b=>b.addEventListener('click',()=>{dialogPhoto.hidden=true;modal.querySelector('.eyebrow').textContent="A TASTE OF BABA'S"}));
document.querySelectorAll('.pour-details').forEach(b=>b.addEventListener('click',()=>{const card=b.closest('.pour-card'),photo=card.querySelector('img');dialogPhoto.src=photo.src;dialogPhoto.alt=photo.alt;dialogPhoto.hidden=false;modal.querySelector('.eyebrow').textContent="THE BABA'S BAR COLLECTION"}));
document.querySelectorAll('.pour-card').forEach(card=>{card.addEventListener('pointermove',e=>{if(e.pointerType==='touch'||paused)return;const r=card.getBoundingClientRect(),x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5;card.style.transform=`perspective(1100px) rotateX(${-y*6}deg) rotateY(${x*8}deg) translateY(-4px)`;card.style.setProperty('--px',`${-x*9}px`);card.style.setProperty('--py',`${-y*7}px`)});card.addEventListener('pointerleave',()=>{card.style.transform='';card.style.setProperty('--px','0px');card.style.setProperty('--py','0px')})});
const storyVisual=document.querySelector('.story-visual');storyVisual.addEventListener('pointermove',e=>{if(e.pointerType==='touch'||paused)return;const r=storyVisual.getBoundingClientRect();storyVisual.style.setProperty('--sx',`${((e.clientX-r.left)/r.width-.5)*-15}px`);storyVisual.style.setProperty('--sy',`${((e.clientY-r.top)/r.height-.5)*-12}px`)});storyVisual.addEventListener('pointerleave',()=>{storyVisual.style.setProperty('--sx','0px');storyVisual.style.setProperty('--sy','0px')});
// Make the entire category card activate its existing details control.
document.querySelectorAll('.pour-card').forEach(card=>{
 const button=card.querySelector('.pour-details');
 card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label',`View ${button.dataset.title} category`);card.setAttribute('aria-haspopup','dialog');
 button.tabIndex=-1;
 card.addEventListener('click',event=>{if(!event.target.closest('.pour-details'))button.click()});
 card.addEventListener('keydown',event=>{if(event.target===card&&(event.key==='Enter'||event.key===' ')){event.preventDefault();button.click()}});
});
// Featured menu cards open from their entire surface.
document.querySelectorAll('.dish').forEach(card=>{
 const button=card.querySelector('.dish-more');
 card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label',`Explore ${button.dataset.title}`);card.setAttribute('aria-haspopup','dialog');button.tabIndex=-1;
 card.addEventListener('click',event=>{if(!event.target.closest('.dish-more'))button.click()});
 card.addEventListener('keydown',event=>{if(event.target===card&&(event.key==='Enter'||event.key===' ')){event.preventDefault();button.click()}});
});
})();
