const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.resolve(__dirname, '../alabama-wholesale-v9.html'), 'utf8');

function setup(fail = false) {
  const start = html.indexOf('const FIREBASE_APPCHECK_SITE_KEY =');
  assert.notEqual(start, -1, 'Production App Check initializer exists');
  const state = {aiModel: {stale:true}, ai:{stale:true}, appCheck:{stale:true}};
  const status = {};
  const context = vm.createContext({CLOUD:state, FIREBASE_CONFIG:{appId:'our-web-app'}, document:{getElementById:()=>status}, console:{warn:()=>{}}});
  vm.runInContext(html.slice(start, html.indexOf('// Accept any of these paste formats:', start)), context);
  const app = {options:{appId:'our-web-app'}};
  const sdk = {
    appCheck:{
      ReCaptchaEnterpriseProvider: class {constructor(key) {this.key=key;}},
      initializeAppCheck: (actualApp, options) => {if (fail) throw new Error('Provider unavailable'); assert.equal(actualApp,app); assert.equal(options.isTokenAutoRefreshEnabled,true); return {app:actualApp,options};}
    },
    ai:{GoogleAIBackend:class {},getAI:actualApp=>({app:actualApp}),getGenerativeModel:ai=>({ai})}
  };
  return {context,state,status,app,sdk};
}

test('App Check and Gemini share the configured web app', () => {
  const {context,state,app,sdk} = setup();
  assert.equal(context._prepareFirebaseAI(app,sdk), true);
  assert.equal(state.appCheck.app,app);
  assert.equal(state.aiModel.ai.app,app);
  assert.equal(context.FIREBASE_APPCHECK_DEBUG_TOKEN,undefined);
});

test('A provider failure clears stale AI state without throwing into cloud sync', () => {
  const {context,state,status,app,sdk} = setup(true);
  assert.equal(context._prepareFirebaseAI(app,sdk), false);
  assert.equal(state.aiModel,null);
  assert.equal(state.appCheck,null);
  assert.match(status.textContent,/unavailable/i);
});

test('A different Firebase web app cannot reuse this project provider', () => {
  const {context,state,sdk} = setup();
  assert.equal(context._prepareFirebaseAI({options:{appId:'different-app'}},sdk), false);
  assert.equal(state.aiModel,null);
});
