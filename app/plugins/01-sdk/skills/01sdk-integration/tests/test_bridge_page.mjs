import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(here, '../assets/bridge_test.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
// Offline page-contract tests only. These native responses are fixtures, not SDK/device evidence.
function page({legacy=false, search='', editor=false, preliminary=false}={}) {
  const elements=new Map(), calls=[], timers=new Set(); let disposed=false, context;
  const el=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',disabled:false,scrollHeight:0,scrollTop:0});return elements.get(id);};
  const later=(fn,ms=0)=>{const id=setTimeout(()=>{timers.delete(id);if(!disposed)fn();},ms>=8000?70:ms);timers.add(id);return id;};
  const clear=id=>{clearTimeout(id);timers.delete(id);};
  function replyFor(action,args) {
    const ack={type:'bridgeAck',requestId:args.requestId,action,ok:true,error:null,data:{}};
    if(action==='getIntegrationStatus'){ack.data={platform:editor?'OSXEditor':'IPhonePlayer'};return ack;}
    if(action==='getAppsFlyerData')return legacy?
      {type:'appsFlyerInfo',requestId:args.requestId,provider:'appsflyer',appsFlyerId:'fixture-id',conversionData:{},platform:'IPhonePlayer',available:true}:
      {type:'appsflyer',requestId:args.requestId,info:{appsflyer_id:editor?'':'fixture-id',af_status:'Organic',is_first_launch:false}};
    if(['onEventJs','onAppsFlyerEvent','onFacebookEvent'].includes(action)){
      const name=args.eventName||args.eventToken||'';let error='';
      if(!/^[A-Za-z][A-Za-z0-9_ .-]{0,39}$/.test(name))error='invalid_event_name';
      else if(args.params){try{JSON.parse(args.params);}catch{error='invalid_json';}}
      if(!error&&editor)error='sdk_unavailable_in_editor';
      if(action!=='onFacebookEvent'&&!legacy){const r={type:'appsflyerEventAck',requestId:args.requestId,ok:!error,eventToken:name};if(error)r.error=error;return r;}
      ack.ok=!error;ack.error=error||null;ack.data={status:'queued',deliveryVerified:false};return ack;
    }
    if(action==='sendData'){try{ack.data.payload=JSON.parse(args.payload);}catch{ack.ok=false;ack.error='invalid_json';}return ack;}
    if(action==='setOrientation'){ack.data.orientation=args.orientation;return ack;}
    if(action==='openURL'){ack.ok=!args.url.startsWith('javascript:');ack.error=ack.ok?null:'invalid_url';return ack;}
    return ack;
  }
  const location={search};Object.defineProperty(location,'href',{set(value){
    const u=new URL(value),action=u.hostname||u.pathname.slice(1),args=Object.fromEntries(u.searchParams);calls.push({action,args});
    if(action==='integrationTestResult')return;
    // Deliver fixtures before shortened timeout timers, even on a busy host.
    // This exercises asynchronous callbacks without turning VM startup latency into a native timeout.
    queueMicrotask(()=>{
      if(disposed)return;
      if(preliminary){context.window.onUnityMessage({type:'bridgeAck',requestId:args.requestId,action,ok:true,data:{}});context.window.onUnityMessage({...replyFor(action,args),requestId:'unrelated'});}
      context.window.onUnityMessage(replyFor(action,args));
    });
  }});
  context=vm.createContext({URL,URLSearchParams,console,Date,Map,Promise,JSON,setTimeout:later,clearTimeout:clear,window:{location},document:{getElementById:el,querySelectorAll:()=>[]}});
  vm.runInContext(source,context);
  return {api:context.window.integrationBridge,calls,dispose(){disposed=true;for(const id of timers)clearTimeout(id);}};
}
async function withPage(options,fn){const p=page(options);try{await fn(p);}finally{p.dispose();}}
test('new attribution envelope resolves with boolean types intact',()=>withPage({},async p=>{const r=await p.api.request('getAppsFlyerData');assert.equal(r.type,'appsflyer');assert.equal(r.info.appsflyer_id,'fixture-id');assert.equal(r.info.is_first_launch,false);}));
test('legacy attribution envelope does not silently pass',()=>withPage({legacy:true},async p=>{await assert.rejects(p.api.request('getAppsFlyerData'),/callback_timeout/);}));
test('eventName receives AppsFlyer-specific receipt',()=>withPage({},async p=>{const r=await p.api.request('onEventJs',{eventName:'test_event'});assert.equal(r.type,'appsflyerEventAck');assert.equal(r.eventToken,'test_event');assert.equal(r.ok,true);}));
test('eventToken alias is accepted by the page contract',()=>withPage({},async p=>{const r=await p.api.request('onEventJs',{eventToken:'alias_event'});assert.equal(r.eventToken,'alias_event');assert.equal(r.ok,true);}));
test('empty eventName falls back to confirmed eventToken alias',()=>withPage({},async p=>{const r=await p.api.request('onEventJs',{eventName:'',eventToken:'fallback_event'});assert.equal(r.eventToken,'fallback_event');assert.equal(r.ok,true);}));
test('explicit eventName retains priority over eventToken',()=>withPage({},async p=>{const r=await p.api.request('onEventJs',{eventName:'primary_event',eventToken:'secondary_event'});assert.equal(r.eventToken,'primary_event');assert.equal(r.ok,true);}));
test('onAppsFlyerEvent action uses the same AF receipt contract',()=>withPage({},async p=>{const r=await p.api.request('onAppsFlyerEvent',{eventToken:'alias_event'});assert.equal(r.type,'appsflyerEventAck');assert.equal(r.eventToken,'alias_event');}));
test('AppsFlyer-specific failure is resolved, not mistaken for timeout',()=>withPage({},async p=>{const r=await p.api.request('onEventJs',{eventToken:'invalid%name'});assert.equal(r.type,'appsflyerEventAck');assert.equal(r.ok,false);assert.equal(r.error,'invalid_event_name');}));
test('generic AF receipt is rejected',()=>withPage({legacy:true},async p=>{await assert.rejects(p.api.request('onEventJs',{eventName:'test_event'}),/callback_timeout/);}));
test('preliminary/wrong-ID replies cannot consume attribution response',()=>withPage({preliminary:true},async p=>{const r=await p.api.request('getAppsFlyerData');assert.equal(r.type,'appsflyer');}));
test('FB and orientation keep generic acknowledgement',()=>withPage({},async p=>{assert.equal((await p.api.request('onFacebookEvent',{eventName:'test_event'})).type,'bridgeAck');assert.equal((await p.api.request('setOrientation',{orientation:'portrait'})).data.orientation,'portrait');}));
test('loading the page performs no bridge actions',()=>withPage({},async p=>{await new Promise(r=>setTimeout(r,25));assert.equal(p.calls.length,0);}));
test('legacy autorun URL cannot trigger rotations or tracking at startup',()=>withPage({search:'?autorun=1'},async p=>{await new Promise(r=>setTimeout(r,25));assert.equal(p.calls.length,0);}));
for(const editor of [false,true])test(`explicit suite verifies 16 cases in ${editor?'Editor':'device'} contract without claiming delivery`,()=>withPage({editor},async p=>{const r=await p.api.runTests();assert.equal(r.passed,true,JSON.stringify(r.cases.filter(x=>!x.passed)));assert.equal(r.cases.length,16);assert.equal(r.sdkDeliveryVerified,false);assert.equal(r.cleanupCompleted,false);assert.equal(r.orientationRestoreRequired,true);assert.equal(p.calls.filter(x=>x.action==='integrationTestResult').length,1);}));
