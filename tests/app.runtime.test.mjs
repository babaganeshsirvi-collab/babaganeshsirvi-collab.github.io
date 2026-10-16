import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {pbkdf2Sync} from 'node:crypto';
import {Miniflare} from 'miniflare';
test('full application keeps preview public, admin private, checkout and SMS off until configured',async()=>{
 const salt='1234567890abcdef1234567890abcdef',password='test-only-admin-password';
 const mf=new Miniflare({modules:true,scriptPath:'dist/server/index.js',compatibilityDate:'2026-01-01',d1Databases:['DB'],durableObjects:{ADMIN_PASSWORD_HASHER:{className:'AdminPasswordHasher',useSQLite:true}},bindings:{BR_ADMIN_USERNAME:'test-owner',BR_ADMIN_SALT:salt,BR_ADMIN_HASH:pbkdf2Sync(password,Buffer.from(salt,'hex'),310000,32,'sha256').toString('hex')},assets:{directory:'dist/client',binding:'ASSETS',routerConfig:{has_user_worker:true,invoke_user_worker_ahead_of_assets:true},assetConfig:{html_handling:'auto-trailing-slash'}}});
 try{const db=await mf.getD1Database('DB');for(const file of (await readdir('migrations')).filter(x=>x.endsWith('.sql')).sort())for(const sql of (await readFile('migrations/'+file,'utf8')).split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();
 const send=(path,body,headers={})=>mf.dispatchFetch('https://site.test'+path,{method:'POST',headers:{Origin:'https://site.test','Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 let response=await mf.dispatchFetch('https://site.test/api/site');assert.equal(response.status,200);assert.equal((await response.json()).details.phone,'');
 response=await mf.dispatchFetch('https://site.test/api/admin-site');assert.equal(response.status,401);
 response=await mf.dispatchFetch('https://site.test/api/payment-config');assert.equal((await response.json()).configured,false);
 response=await send('/api/customer-send',{phone:'9876543210'});assert.equal(response.status,503);
 response=await send('/api/login',{username:'test-owner',password});assert.equal(response.status,200);const cookie=response.headers.get('Set-Cookie').split(';')[0],session=await response.json();assert.ok(session.csrf);
 response=await mf.dispatchFetch('https://site.test/api/admin-site',{headers:{Cookie:cookie}});assert.equal(response.status,200);
 response=await send('/api/customer-send',{phone:'9876543210'},{Cookie:cookie});assert.equal(response.status,503); // Admin cookie must not require admin CSRF here.
 response=await send('/api/launch-save',{}, {Cookie:cookie});assert.equal(response.status,403);
 response=await send('/api/upload',{data:'iVBORw=='},{Cookie:cookie,'X-CSRF-Token':session.csrf});assert.equal(response.status,503);assert.match((await response.json()).error,/uploads are not connected/);
 response=await mf.dispatchFetch('https://site.test/assets/uploads/missing.png');assert.equal(response.status,404);
 response=await mf.dispatchFetch('https://site.test/');assert.equal(response.status,200);assert.match(await response.text(),/Baba's Bar &amp;|Baba's Bar & Restro/);
 for(const [name,value] of [['X-Content-Type-Options','nosniff'],['X-Frame-Options','DENY'],['Referrer-Policy','strict-origin-when-cross-origin']])assert.equal(response.headers.get(name),value);
 response=await mf.dispatchFetch('https://site.test/.admin/admin.sqlite3');assert.equal(response.status,404);
 }finally{await mf.dispose()}
});
