"""Browser integration checks using a simulated Supabase service.

Requires the local game server on port 3000, Python Playwright, and Chromium.
These checks do not verify deployment to the real hosted Supabase project.
"""
import json, uuid
from playwright.sync_api import sync_playwright, expect
CODE='abc123def456'
steps=['Schedule a medical appointment.','Arrive at the clinic and complete registration or check-in.','Wait in the waiting room for your appointment with the doctor.','See the doctor, who identifies the need for further tests.','Receive an X-ray referral from the doctor.','Book a date and time for the X-ray.','Attend the X-ray appointment.','Have the X-ray taken.','The doctor evaluates the X-ray results, confirms the diagnosis, and prescribes therapy.']
ids=[str(uuid.uuid4()) for _ in steps]
meta={'code':CODE,'title':'Patient Journey Event','active':True,'scenario':{'title':'The road to a diagnosis','category':'PATIENT JOURNEY','description':'Arrange the steps to receive a diagnosis.','step_count':9}}
rounds={}; submissions=[]; rows=[]; failures={'lose_response':True,'board':False}
def handler(route):
    req=route.request
    if req.method=='OPTIONS':
        route.fulfill(status=200,headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'});return
    data=req.post_data_json
    name=req.url.split('/')[-1]
    if name=='get_event': result=meta
    elif name=='get_leaderboard':
        if failures['board']:
            route.abort();return
        result=rows
    elif name=='start_round':
        token=str(uuid.uuid4());rounds[token]={'name':data['p_name']}
        result={'token':token,'started_at':'2026-10-29T00:00:00Z','steps':[{'id':ids[i],'text':steps[i]} for i in reversed(range(9))]}
    elif name=='submit_round':
        assert set(data)=={'p_token','p_order'}, 'Browser must not supply a score or time'
        submissions.append(data)
        r=rounds[data['p_token']]
        if 'result' not in r:
            correct=[id for index,id in enumerate(data['p_order']) if ids[index]==id]
            r['result']={'correct':len(correct),'total':9,'score':round(len(correct)/9*100),'seconds':12,'correct_ids':correct,'steps':steps,'explanation':'Follow the patient journey.'}
            rows.append({'name':r['name'],'score':r['result']['score'],'seconds':12})
        result=r['result']
        if failures['lose_response']:
            failures['lose_response']=False;route.abort();return
    else: raise AssertionError(req.url)
    route.fulfill(status=200,content_type='application/json',body=json.dumps(result),headers={'Access-Control-Allow-Origin':'*'})
def solve(page):
    for index,id in enumerate(ids):
        while True:
            order=page.locator('.flow-card').evaluate_all('(els)=>els.map(el=>el.dataset.stepId)')
            pos=order.index(id)
            if pos==index:break
            page.locator('.flow-card').nth(pos).locator('[data-direction="up"]').click()
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    c1=browser.new_context(viewport={'width':390,'height':844});c2=browser.new_context(viewport={'width':1280,'height':900})
    for c in [c1,c2]:
        c.route('**/config.json',lambda route: route.fulfill(status=200,content_type='application/json',body=json.dumps({'supabaseUrl':'https://mock-project.supabase.co','supabaseKey':'sb_publishable_browser_test'})))
        c.route('https://mock-project.supabase.co/**',handler)
    a=c1.new_page();b=c2.new_page();errors=[]
    for page in [a,b]:
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:3000/?event='+CODE,wait_until='networkidle')
        expect(page.locator('#shared-event-name')).to_have_text('Patient Journey Event')
        assert page.locator('.flow-card').count()==0
    a.locator('#player-name').fill('   ');a.locator('#start-round').click()
    assert a.locator('#player-name').evaluate('(el)=>el.validationMessage')
    a.locator('#player-name').fill('Team A');a.locator('#start-round').click()
    expect(a.locator('.flow-card')).to_have_count(9)
    solve(a);a.locator('#submit-flow').click()
    expect(a.locator('#submit-flow')).to_have_text('Retry submission →')
    assert a.locator('#result-panel').is_hidden()
    assert a.locator('.move-button:not(:disabled)').count()==0
    assert len(rows)==1
    a.locator('#submit-flow').click()
    expect(a.locator('#score-value')).to_have_text('100')
    assert submissions[0]==submissions[1] and len(rows)==1
    expect(a.locator('.flow-card.is-correct')).to_have_count(9)
    b.locator('#refresh-leaderboard').click()
    expect(b.locator('#leaderboard-list')).to_contain_text('Team A')
    b.locator('#player-name').fill('Team B');b.locator('#start-round').click()
    expect(b.locator('.flow-card')).to_have_count(9)
    solve(b);b.locator('#submit-flow').click()
    expect(b.locator('#score-value')).to_have_text('100')
    a.locator('#refresh-leaderboard').click()
    expect(a.locator('#leaderboard-list')).to_contain_text('Team B')
    expect(a.locator('.leaderboard-row')).to_have_count(2)
    failures['board']=True
    a.locator('#refresh-leaderboard').click()
    expect(a.locator('#shared-status')).to_contain_text('Could not refresh')
    expect(a.locator('.leaderboard-row')).to_have_count(2)
    failures['board']=False
    a.locator('#projector-toggle').click()
    assert a.locator('body').evaluate('(el)=>el.classList.contains("projector-mode")')
    assert a.locator('.game-layout').is_hidden()
    assert a.evaluate('document.documentElement.scrollWidth<=innerWidth')
    a.screenshot(path='/tmp/shared-projector-mobile.png',full_page=True)
    a.locator('#projector-toggle').click()
    a.locator('#leave-event').click()
    expect(a.locator('#leaderboard-scope')).to_have_text('This device only')
    expect(a.locator('.flow-card')).to_have_count(9)
    a.reload(wait_until='networkidle')
    expect(a.locator('#leaderboard-scope')).to_have_text('This device only')
    assert a.locator('.leaderboard-row').count()==0, 'Shared scores must not go into local storage'
    assert not errors, errors
    print('PASS: two independent browsers share results; server score used; lost-response retry submits identical payload once; cards freeze on pending result; stale board retains rows with error; projector/mobile; leave restores local; no pageerrors.')
    browser.close()
