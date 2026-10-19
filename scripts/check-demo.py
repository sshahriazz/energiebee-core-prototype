"""Browser regression checks against a running recorded demo. Requires playwright.
DEMO_URL defaults to http://127.0.0.1:4102; CHROME_BIN can select another Chrome.
Screenshots are saved under /tmp/energiebee-demo-review.
"""
import os
from playwright.sync_api import sync_playwright
from pathlib import Path
import json
out=Path('/tmp/energiebee-demo-review');out.mkdir(exist_ok=True)
with sync_playwright() as p:
 b=p.chromium.launch(executable_path=os.environ.get('CHROME_BIN','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless=True)
 c=b.new_context(viewport={'width':1440,'height':1000});page=c.new_page();base=os.environ.get('DEMO_URL','http://127.0.0.1:4102');errs=[];requests=[]
 sid=c.request.get(base+'/api/sites').json()[0]['id']
 page.on('pageerror',lambda e:errs.append(str(e)));page.on('request',lambda r:requests.append(r.url))
 for width in [1440,768,390]:
  page.set_viewport_size({'width':width,'height':1000 if width>390 else 844})
  for path in ['/','/timeline','/evidence','/how-it-works']:
   page.goto(base+path,wait_until='networkidle');page.wait_for_function("document.querySelector('#content').getAttribute('aria-busy')==='false'")
   if path=='/evidence':page.wait_for_function("document.querySelector('#slot-content').getAttribute('aria-busy')==='false'")
   print('RENDER',width,path,'overflow',page.evaluate('document.documentElement.scrollWidth>innerWidth'),'chars',len(page.locator('#content').inner_text()),'date',page.locator('#date').input_value() if path != '/how-it-works' else 'guide',flush=True)
   assert not page.evaluate('document.documentElement.scrollWidth>innerWidth'), (width,path,'page overflow')
   page.screenshot(path=str(out/f'{path.strip("/") or "overview"}-{width}.png'),full_page=True)
 assert not errs,errs
 assert not any('/forecast' in r or '/compare' in r or '/insights' in r for r in requests),requests
 # Expanded intervals retain original values and expose all flows and evidence.
 page.goto(base+'/timeline',wait_until='networkidle')
 day=c.request.get(base+f'/api/demo/sites/{sid}/day?date='+page.locator('#date').input_value()).json()
 assert page.locator('.record-detail').count()==len(day['rows'])
 for i,row in enumerate(day['rows']):
  detail=page.locator('.record-detail').nth(i)
  assert detail.locator('.flow-list > div').count()==10
  assert str(row['slot_start']) in detail.locator('a.button').get_attribute('href')
 page.locator('.record-detail summary').first.click()
 assert page.locator('.record-explanation').first.is_visible()
 page.screenshot(path=str(out/'timeline-expanded-390.png'),full_page=False)
 page.get_by_role('link',name='How it works',exact=True).click();page.wait_for_load_state('networkidle')
 assert page.locator('#nav [aria-current="page"]').inner_text()=='How it works'
 assert 'date='+day['date'] in page.get_by_role('link',name='Open the timeline').get_attribute('href')
 page.route('**/api/**',lambda r:r.abort())
 page.reload(wait_until='networkidle');assert page.get_by_role('heading',name='What the software actually does').is_visible()
 page.unroute('**/api/**')
 print('EXPLANATIONS_AND_OFFLINE_GUIDE PASS',flush=True)
 # Main user journey and date consistency.
 page.set_viewport_size({'width':1440,'height':1000});page.goto(base,wait_until='networkidle');date=page.locator('#date').input_value()
 page.get_by_role('link',name='Explore this day').click();page.wait_for_load_state('networkidle');assert '/timeline?' in page.url
 assert page.locator('#date').input_value()==date
 link=page.locator('.bar-link').nth(24);href=link.get_attribute('href');link.click();page.wait_for_load_state('networkidle');page.wait_for_function("document.querySelector('#slot-content').getAttribute('aria-busy')==='false'")
 assert page.locator('#date').input_value()==date
 assert href.split('slot=')[-1] == page.locator('#slot').input_value()
 assert page.locator('[data-source="sunsynk_daily"]').count()>0
 page.locator('[data-raw]').first.click();page.wait_for_selector('#raw-body pre');assert page.locator('#raw-dialog').evaluate('(e)=>e.open');page.keyboard.press('Escape');assert not page.locator('#raw-dialog').evaluate('(e)=>e.open')
 page.locator('#slot').select_option(index=1);page.wait_for_function("document.querySelector('#slot-content').getAttribute('aria-busy')==='false'")
 print('JOURNEY PASS',date,flush=True)
 # All historical days and agreement of totals with displayed rows.
 days=c.request.get(base+f'/api/demo/sites/{sid}/days').json()
 for d in days['days']:
  r=c.request.get(base+f'/api/demo/sites/{sid}/day?date='+d['local_date']);assert r.status==200;data=r.json()
  for key,t in data['totals'].items():
   xs=[x[key] for x in data['rows'] if x[key] is not None]
   assert (t['value'] is None if not xs else abs(t['value']-sum(xs))<1e-9)
 print('ALL_DAYS',len(days['days']),'DEFAULT',days['defaultDate'],flush=True)
 for invalid in ['2026-02-30','bad','2099-01-01']:
  r=c.request.get(base+f'/api/demo/sites/{sid}/day?date='+invalid);assert r.status in [400,404]
 for hidden in ['/my','/solar','/battery','/grid','/tariffs','/ev','/data','/index.html/other']:
  assert c.request.get(base+hidden).status==404,hidden
 assert c.request.post(base+f'/api/sites/{sid}/sync').status==405
 assert c.request.post(base+f'/api/sites/{sid}/rebuild').status==405
 print('HIDDEN_ROUTES_AND_READ_ONLY PASS',flush=True)
 # No forecast dependency even when every forecast request would fail.
 page.route('**/forecast*',lambda r:r.abort());page.goto(base,wait_until='networkidle');assert page.locator('.hero-number').count()==1
 page.unroute('**/forecast*')
 # A day API outage gives a recoverable error.
 page.route('**/api/demo/sites/*/day?*',lambda r:r.fulfill(status=503,content_type='application/json',body='{"error":"Temporarily unavailable"}'))
 page.goto(base,wait_until='networkidle');assert page.get_by_role('button',name='Try again').count()==1
 page.unroute('**/api/demo/sites/*/day?*');page.get_by_role('button',name='Try again').click();page.wait_for_selector('.hero-number');print('DAY_RETRY PASS',flush=True)
 # Browser-only fixture for a real no-home response.
 page.route('**/api/sites',lambda r:r.fulfill(status=200,content_type='application/json',body='[]'))
 page.goto(base,wait_until='networkidle');assert 'No home connected yet' in page.locator('#content').inner_text();page.unroute('**/api/sites')
 # Raw evidence failure also has a recovery path.
 page.goto(base+'/evidence',wait_until='networkidle');page.wait_for_selector('[data-raw]')
 page.route('**/api/raw/*',lambda r:r.fulfill(status=503,content_type='application/json',body='{"error":"Response unavailable"}'))
 page.locator('[data-raw]').first.click();page.wait_for_selector('#raw-body [role="alert"]');page.unroute('**/api/raw/*');page.get_by_role('button',name='Retry response').click();page.wait_for_selector('#raw-body pre');page.get_by_role('button',name='Close provider response').click()
 print('EMPTY_AND_RAW_RETRY PASS',flush=True)
 # Date change remains selected through nav links.
 provisional=next(d['local_date'] for d in days['days'] if d['slots_provisional']>0)
 page.locator('#date').select_option(provisional);page.wait_for_load_state('networkidle');page.wait_for_selector('#slot')
 page.get_by_role('link',name='Overview',exact=True).click();page.wait_for_load_state('networkidle');assert page.locator('#date').input_value()==provisional
 assert 'provisional' in page.locator('#content').inner_text();print('DATE_NAV PASS',flush=True)
 print('ERRORS',errs,flush=True);assert not errs
 b.close()
