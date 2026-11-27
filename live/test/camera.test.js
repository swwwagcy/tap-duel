// With more than one camera (built in, plus an action camera on USB), the reader offers a choice,
// remembers it, and falls back to the usual camera when the chosen one is gone.
const path=require('path'),http=require('http'),fs=require('fs');const {chromium}=require('playwright');const assert=require('assert');
const ROOT=path.join(__dirname,'..','public');
const server=http.createServer((q,r)=>{fs.readFile(path.join(ROOT,new URL(q.url,'http://x').pathname),(e,d)=>{if(e){r.writeHead(404);r.end();return}r.writeHead(200,{'Content-Type':q.url.split('?')[0].endsWith('.js')?'text/javascript':'text/html; charset=utf-8'});r.end(d)})});
(async()=>{await new Promise(r=>server.listen(0,r));const b=await chromium.launch();const ctx=await b.newContext();
await ctx.addInitScript(()=>{
  const calls=JSON.parse(sessionStorage.getItem('calls')||'[]');window.__calls=calls;
  const cams=[{kind:'videoinput',deviceId:'phone-cam',label:'Built-in Camera'},{kind:'videoinput',deviceId:'obs-virtual',label:'OBS Virtual Camera'}];
  navigator.mediaDevices.enumerateDevices=async()=>cams;
  navigator.mediaDevices.getUserMedia=async(c)=>{calls.push(c.video);sessionStorage.setItem('calls',JSON.stringify(calls));
    if(c.video.deviceId && c.video.deviceId.exact==='gone') throw Object.assign(new Error('x'),{name:'OverconstrainedError'});
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const g=canvas.getContext('2d');setInterval(()=>{g.fillStyle='#1f5e3a';g.fillRect(0,0,640,360)},100);
    const s=canvas.captureStream(10);const t=s.getVideoTracks()[0];const id=c.video.deviceId?c.video.deviceId.exact:'phone-cam';t.getSettings=()=>({deviceId:id});return s;};
});
const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
const base='http://localhost:'+server.address().port+'/reader.html?demo&table=duel';
await page.goto(base);await page.waitForTimeout(800);
await page.click('#startCamera');await page.waitForSelector('#cameraPickBox:not([hidden])');
const opts=await page.$$eval('#cameraPick option',o=>o.map(x=>[x.value,x.textContent,x.selected]));
console.log('options',JSON.stringify(opts));assert.deepStrictEqual(opts.map(o=>o[2]),[true,false]);
assert.ok(!(await page.evaluate(()=>window.__calls[0])).deviceId,'first start uses the usual camera');
await Promise.all([page.waitForNavigation(),page.selectOption('#cameraPick','obs-virtual')]);
await page.waitForTimeout(800);await page.click('#startCamera');await page.waitForSelector('#cameraPickBox:not([hidden])');
const last=await page.evaluate(()=>window.__calls[window.__calls.length-1]);console.log('after switch',JSON.stringify(last));
assert.strictEqual(last.deviceId.exact,'obs-virtual');
assert.strictEqual(await page.$eval('#cameraPick',s=>s.value),'obs-virtual');
// a stored camera that is gone falls back to the usual one
await page.evaluate(()=>localStorage.setItem('tdl-reader-camera',JSON.stringify('gone')));await page.reload();await page.waitForTimeout(800);
await page.click('#startCamera');await page.waitForSelector('#cameraPickBox:not([hidden])');
const fb=await page.evaluate(()=>window.__calls.slice(-2));console.log('fallback',JSON.stringify(fb));
assert.strictEqual(fb[0].deviceId.exact,'gone');assert.ok(!fb[1].deviceId);
assert.strictEqual(await page.evaluate(()=>localStorage.getItem('tdl-reader-camera')),null);
assert.deepStrictEqual(errors,[]);console.log('camera choice ok');
await b.close();server.close()})().catch(e=>{console.error(e);process.exit(1)});
