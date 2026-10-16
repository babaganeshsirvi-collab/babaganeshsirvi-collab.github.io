import * as auth from './auth.js';
import * as payments from './payments.js';
import siteSeed from './site-seed.json' with {type:'json'};
import pins from './rajasthan-pincodes.json' with {type:'json'};
import catalogue from './catalogue-seed.json' with {type:'json'};
import launchSeed from './launch-seed.json' with {type:'json'};
const json=(payload,status=200,extra={})=>Response.json(payload,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'strict-origin-when-cross-origin',...extra}});
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const statement=(env,sql,...values)=>env.DB.prepare(sql).bind(...values);
async function load(env,key,seed){await statement(env,'INSERT OR IGNORE INTO br_settings(key,value) VALUES(?,?)',key,JSON.stringify(seed)).run();const row=await statement(env,'SELECT value FROM br_settings WHERE key=?',key).first();return JSON.parse(row.value)}
const site=env=>load(env,'site',siteSeed),config=env=>load(env,'launch',launchSeed);
const rajasthanPins=new Set(pins.pincodes);
async function limit(env,r,key,max=12){const ip=r.headers.get('CF-Connecting-IP')||'local',bucket=key+':'+ip,now=Math.floor(Date.now()/1000),after=now-60;const result=await statement(env,'INSERT INTO br_rate(key,created) SELECT ?,? WHERE (SELECT COUNT(*) FROM br_rate WHERE key=? AND created>?)<?',bucket,now,bucket,after,max).run();if(!result.meta.changes)throw error('Please wait before trying again.',429)}
const safeSite=data=>({...data,details:{...data.details,phone:''}});
async function write(env,key,data){await statement(env,'UPDATE br_settings SET value=? WHERE key=?',JSON.stringify(data),key).run()}
async function requestBody(r){const max=new URL(r.url).pathname==='/api/upload'?7500000:400000;if(Number(r.headers.get('Content-Length'))>max)throw error('Request too large.',413);if(!r.headers.get('Content-Type')?.startsWith('application/json'))throw error('JSON required.');const raw=await r.text();if(raw.length>max)throw error('Request too large.',413);try{const data=JSON.parse(raw);if(!data||typeof data!=='object'||Array.isArray(data))throw Error();return data}catch{throw error('Invalid request.')}}
function validateSite(data){if(!data||!data.details||!Array.isArray(data.menu)||!Array.isArray(data.bar)||!data.catalogueOverrides||data.menu.length>200||data.bar.length>200)throw error('Invalid menu data.');if(Object.keys(data.catalogueOverrides).length>5000)throw error('Invalid bottle data.');for(const k of ['tagline','intro','footer','phone','address','hours'])if(typeof data.details[k]!=='string'||data.details[k].length>1500)throw error('Invalid restaurant details.');for(const group of ['menu','bar']){const seen=new Set();for(const p of data[group]){for(const k of ['id','name','description','price'])if(typeof p[k]!=='string'||p[k].length>1500)throw error('Invalid menu text.');if(!p.name.trim()||seen.has(p.id)||typeof p.available!=='boolean')throw error('Check item name, ID and availability.');seen.add(p.id);if(p.price&&(!Number.isFinite(Number(p.price))||Number(p.price)<0||Number(p.price)>1000000))throw error('Invalid price.');if(group==='menu'&&(!['food','drinks'].includes(p.category)||typeof p.label!=='string'||!/^assets\/[^\s]*$|^https:\/\//.test(p.image)||p.image.includes('..')))throw error('Invalid image or category.')}}for(const p of Object.values(data.catalogueOverrides))if(typeof p.available!=='boolean'||typeof p.description!=='string'||p.description.length>1500||typeof p.servingPrice!=='string'||p.servingPrice&&(!Number.isFinite(Number(p.servingPrice))||Number(p.servingPrice)<0||Number(p.servingPrice)>1000000))throw error('Invalid bottle update.');return data}
async function upload(env,b){if(!env.BUCKET)throw error('Image uploads are not connected yet. Configure private storage to enable uploads.',503);if(typeof b.data!=='string')throw error('Select an image.');let bytes;try{bytes=Uint8Array.from(atob(b.data),c=>c.charCodeAt(0))}catch{throw error('Invalid image.')}if(!bytes.length||bytes.length>5*1024*1024)throw error('Choose an image up to 5 MB.');const ext=bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71?'png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'jpg':String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP'?'webp':null;if(!ext)throw error('Use PNG, JPG or WebP.');const image='assets/uploads/'+crypto.randomUUID()+'.'+ext;await env.BUCKET.put(image,bytes,{httpMetadata:{contentType:ext==='jpg'?'image/jpeg':'image/'+ext}});return {image}}
export default {async fetch(r,env){const u=new URL(r.url),path=u.pathname;try{
 if(path.startsWith('/assets/uploads/')){if(!env.BUCKET)return new Response('Not found',{status:404});const object=await env.BUCKET.get(path.slice(1));if(!object)return new Response('Not found',{status:404});return new Response(object.body,{headers:{'Content-Type':object.httpMetadata?.contentType||'application/octet-stream','X-Content-Type-Options':'nosniff'}})}
 if(path==='/dist/'||path==='/dist/index.html')return Response.redirect(u.origin+'/',302);
 if(!path.startsWith('/api/'))return env.ASSETS.fetch(r);
 if(!env.DB)throw error('Store temporarily unavailable.',503);
 if(path==='/api/payment-webhook'&&r.method==='POST'){if(Number(r.headers.get('Content-Length'))>64000)throw error('Webhook too large.',413);const raw=await r.text();if(raw.length>64000)throw error('Webhook too large.',413);return json(await payments.webhook(env,raw,r.headers.get('X-Razorpay-Signature')))};
 if(!['GET','POST'].includes(r.method))throw error('Method not allowed.',405);
 if(r.method==='POST'&&r.headers.get('Origin')!==u.origin)throw error('Invalid request origin.',403);
 const admin=await auth.authenticate(new Request(r.url,{method:'GET',headers:r.headers}),env,'admin');
 if(r.method==='GET'){
  if(path==='/api/site')return json(safeSite(await site(env)));
  if(path==='/api/session')return json({authenticated:!!admin,csrf:admin?.csrf||null});
  if(path==='/api/admin-site'){if(!admin)throw error('Please sign in.',401);return json(await site(env))}
  if(path==='/api/store-config')return json(await config(env));
  if(path==='/api/payment-config'){const c=await config(env);return json({configured:c.orderingEnabled&&c.policiesApproved&&payments.configured(env)&&!!env.RAZORPAY_WEBHOOK_SECRET,provider:'Razorpay'})}
  if(path==='/api/customer-profile'){const session=await auth.authenticate(r,env,'customer');return json({authenticated:!!session,configured:auth.customerConfigured(env),profile:session?await auth.customerProfile(env,session):null,csrf:session?.csrf||null})}
  if(!admin)throw error('Please sign in.',401);
  if(path==='/api/orders')return json({orders:await payments.listOrders(env)});
  if(path==='/api/launch-settings')return json(await config(env));
  if(path==='/api/launch-readiness'){const c=await config(env);return json({checks:{'Payment keys configured':payments.configured(env),'Payment webhook secret configured':!!env.RAZORPAY_WEBHOOK_SECRET,'SMS service configured':auth.customerConfigured(env),'Support email added':!!c.supportEmail,'Policies approved':c.policiesApproved,'Online ordering enabled':c.orderingEnabled},images:{total:1954,refined:catalogue.products.filter(p=>p.imageTreatment==='AI-refined illustration').length}})}
  throw error('Not found.',404);
 }
 const b=await requestBody(r);
 if(path==='/api/login'){const result=await auth.adminLogin(r,env,b);return json(result.payload,200,{'Set-Cookie':result.cookie})}
 if(path==='/api/customer-send')return json(await auth.sendOtp(r,env,b));
 if(path==='/api/customer-verify'){const result=await auth.verifyOtp(r,env,b);return json(result.payload,200,{'Set-Cookie':result.cookie})}
 if(path.startsWith('/api/customer-')){const s=await auth.authenticate(r,env,'customer');if(!s)throw error('Verify your mobile number first.',401);if(r.headers.get('X-CSRF-Token')!==s.csrf)throw error('Invalid session token.',403);if(path==='/api/customer-save')return json({profile:await auth.saveCustomer(env,s,b)});if(path==='/api/customer-logout'){const result=await auth.customerLogout(r,env);return json(result.payload,200,{'Set-Cookie':result.cookie})}throw error('Not found.',404)}
 if(path==='/api/payment-order'){await limit(env,r,'checkout');const c={...await config(env),isRajasthanPincode:p=>rajasthanPins.has(p)};return json(await payments.start(env,b,await site(env),c,r))}
 if(path==='/api/payment-verify'){await limit(env,r,'verification');return json(await payments.verify(env,b))}
 if(!admin)throw error('Please sign in.',401);if(r.headers.get('X-CSRF-Token')!==admin.csrf)throw error('Invalid session token.',403);
 if(path==='/api/save'){await write(env,'site',validateSite(b));return json({saved:true})}
 if(path==='/api/upload')return json(await upload(env,b));
 if(path==='/api/order-status')return json(await payments.setFulfilment(env,b));
 if(path==='/api/password'){const result=await auth.changePassword(r,env,admin,b);return json(result.payload,200,{'Set-Cookie':result.cookie})}
 if(path==='/api/logout'){const result=await auth.adminLogout(r,env);return json(result.payload,200,{'Set-Cookie':result.cookie})}
 if(path==='/api/launch-save'){if(!b.supportEmail||!/^\S+@\S+\.\S+$/.test(b.supportEmail)||b.region!=='Rajasthan, India'||b.country!=='IN'||!Array.isArray(b.deliveryPincodes)||b.deliveryPincodes.some(p=>!/^\d{6}$/.test(p)))throw error('Check support email and Rajasthan delivery settings.');for(const k of ['dineInDiscount','deliveryDiscount'])if(!Number.isInteger(b[k])||b[k]<0||b[k]>30)throw error('Discount must be 0–30 percent.');for(const k of ['orderingEnabled','liquorDeliveryEnabled','policiesApproved'])if(typeof b[k]!=='boolean')throw error('Invalid launch switch.');if(b.deliveryPincodes.some(p=>!rajasthanPins.has(p)))throw error('Delivery pincodes must be in Rajasthan.');if(b.orderingEnabled&&await auth.adminPasswordIsDefault(env))throw error('Change the default admin password before enabling orders.');if(b.orderingEnabled&&(!b.policiesApproved||!payments.configured(env)||!env.RAZORPAY_WEBHOOK_SECRET))throw error('Confirm policies and configure payment keys/webhook first.');await write(env,'launch',b);return json(b)}
 throw error('Not found.',404);
 }catch(e){return json({error:e.status?e.message:'Store temporarily unavailable. Please try again.',...(e.code?{code:e.code}:{})},e.status||503)}}};
