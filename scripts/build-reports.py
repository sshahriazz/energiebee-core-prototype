"""Build Technext PDF reports. Requires markdown, playwright, pymupdf and Chrome.
Run: python scripts/build-reports.py
"""
from pathlib import Path
import re, html, base64
import markdown
import pymupdf as fitz
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/reports'
OUT.mkdir(exist_ok=True)
LOGO = ROOT / 'docs/branding/technext-logo.png'
CSS = '''
@page { size:A4; margin:21mm 17mm 20mm; }
@page wide { size:A3 landscape; margin:23mm 18mm; }
@page tall { size:A3 portrait; margin:23mm 18mm; }
@page atlas { size:594mm 420mm; margin:23mm 18mm; }
* {box-sizing:border-box} body{font-family:Arial,sans-serif;color:#151515;font-size:10pt;line-height:1.48;margin:0}
a{color:#be4815;text-decoration:none;overflow-wrap:anywhere} p{margin:0 0 10px;orphans:3;widows:3}
h1,h2,h3,h4{color:#151515;line-height:1.2;break-after:avoid}
h2{font-size:23pt;letter-spacing:-.6px;border-top:4px solid #eb6126;padding-top:17px;margin:0 0 22px;break-before:page}
h3{font-size:14pt;margin:23px 0 12px}h4{font-size:11pt;margin:19px 0 8px}
ul,ol{padding-left:22px;margin:8px 0 13px}li{margin:4px 0;orphans:2;widows:2}li p{margin:3px 0}
strong{color:#151515}hr{border:0;border-top:1px solid #e0e3e6;margin:20px 0}
code{font-family:Menlo,monospace;font-size:.85em;overflow-wrap:anywhere;color:#344452}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f7;border-left:3px solid #eb6126;padding:12px;font-size:8pt;line-height:1.45;break-inside:avoid}
table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:8.3pt;line-height:1.42;margin:14px 0 20px}
thead{display:table-header-group}tr{break-inside:avoid}th{background:#151515;color:white;font-weight:600;text-align:left}th strong{color:white}th,td{padding:8px 9px;border-bottom:1px solid #d9dfe4;vertical-align:top;overflow-wrap:anywhere}tbody tr:nth-child(even){background:#f4f6f8}
table.catalogue td:first-child{width:24%;font-weight:bold;color:#293947}table.catalogue td:last-child{width:76%}table.catalogue thead{display:none}
blockquote{margin:18px 0;padding:12px 15px;border-left:4px solid #eb6126;background:#fff7f2}blockquote table{font-size:8pt}blockquote p:last-child{margin-bottom:0}
.cover{height:246mm;position:relative;break-after:page}.cover img{width:180px;margin-top:8mm}.eyebrow{color:#eb6126;font-size:10pt;font-weight:bold;letter-spacing:2px;text-transform:uppercase}.cover .eyebrow{margin-top:44mm}.cover h1{font-size:44pt;line-height:1.05;letter-spacing:-1.8px;margin:18px 0}.cover .subtitle{font-size:21pt;line-height:1.3;max-width:560px;color:#536371}.cover .rule{width:64px;height:6px;background:#eb6126;margin:27px 0}.cover .meta{font-size:10pt;color:#566570}.contact{position:absolute;bottom:3mm;border-top:1px solid #d8dfe4;width:100%;padding-top:18px;line-height:1.7;font-size:10pt}.contact b{font-size:13pt}
.contents{break-after:page}.contents h2{break-before:auto}.toc-row{display:flex;align-items:baseline;gap:12px;padding:10px 0;border-bottom:1px solid #e1e5e8;font-size:11pt}.toc-row a{color:#151515;flex:1}.toc-number{min-width:30px;text-align:right;color:#be4815}.note{font-size:9pt;color:#63727e;margin-top:25px}
.intro-title{font-size:10pt;letter-spacing:2px;text-transform:uppercase;color:#eb6126;margin-bottom:20px}
figure{margin:16px 0 22px;break-inside:avoid}figure.plate{break-before:page;break-after:page;page:tall;margin:0}figure.wide{page:wide}figure.atlas{page:atlas}figure img{display:block;object-fit:contain;width:100%;max-height:225mm}figure.plate img{height:337mm;max-height:337mm}figure.wide img{height:221mm;max-height:221mm}figure.atlas img{height:345mm;max-height:345mm}figcaption{font-size:10pt;border-top:2px solid #eb6126;padding-top:10px;margin-top:10px;color:#536371}figcaption b{color:#151515}figure h2{break-before:auto;font-size:21pt;margin-bottom:12px}figure h3{margin:10px 0}figure p{font-size:10pt}.plate-label{font-size:11pt;font-weight:bold;letter-spacing:1px;color:#eb6126;margin-bottom:10px}
'''
CONFIG = [('database','Database architecture','Storage, relationships & scaling','TECHNICAL REPORT 01'),('timeline-forecast-and-data-states','Timeline & forecast','Data states, methods & provenance','TECHNICAL REPORT 02')]

def build(browser, slug, title, subtitle, label):
    src=(ROOT/f'docs/{slug}.md').read_text()
    src=re.sub(r'<details>.*?</details>', '', src, flags=re.S)
    src=re.sub(r'^# .*\n','',src,count=1)
    # The source uses CommonMark-style lists directly after paragraphs.
    # Normalize list spacing for Python-Markdown without touching fenced code.
    lines=[]; fenced=False
    for line in src.splitlines():
        if line.startswith('```'): fenced=not fenced
        if not fenced and re.match(r'^(?:[-*] |\d+\. )',line) and lines and lines[-1].strip() and not re.match(r'^(?:\s*[-*] |\s*\d+\. )',lines[-1]):
            lines.append('')
        if not fenced and re.match(r'^ {2,3}[-*] ',line):
            line='    '+line.lstrip()
        lines.append(line)
    src='\n'.join(lines)
    md=markdown.Markdown(extensions=['tables','fenced_code','toc','sane_lists'])
    body=md.convert(src)
    body=re.sub(r'<table>\s*<thead>\s*<tr>\s*<th></th>\s*<th></th>', '<table class="catalogue"><thead><tr><th></th><th></th>',body)
    figures=[]
    def figure(m):
        path,alt=m.group(2),html.unescape(m.group(1))
        p=ROOT/'docs'/path
        number=len(figures)+1; figures.append(p.name)
        classes='plate'
        if p.stem=='db-er-facts': classes+=' atlas'
        elif p.stem in ['db-er-tariffs','db-layers']: classes+=' wide'
        svg=p.read_text()
        palette={'#9370DB':'#eb6126','#ECECFF':'#fff1e9','#ffffde':'#fff7f2',
                 '#aaaa33':'#eb6126','#fff5ad':'#ffdccb','#552222':'#9b3c16',
                 '#131300':'#151515','#333333':'#151515','#333':'#151515',
                 '#e0e0e0':'#e5e5e5','#f0f0f0':'#f5f5f5'}
        svg=re.sub(r'#[0-9a-fA-F]{3,8}\b',lambda m:palette.get(m.group(),m.group()),svg)
        svg=re.sub(r'hsl\(240,\s*100%,\s*97\.2745098039%\)', '#fff7f2', svg)
        data=base64.b64encode(svg.encode()).decode()
        return f'<figure class="{classes}"><div class="plate-label">ENERGIEBEE CORE / FIGURE {number:02}</div><img src="data:image/svg+xml;base64,{data}" alt="{html.escape(alt)}"><figcaption><b>Figure {number:02}.</b> {html.escape(alt)}</figcaption></figure>'
    body=re.sub(r'<p><img alt="([^"]*)" src="([^"]*)"\s*/></p>',figure,body)
    body=body.replace('timeline-forecast-and-data-states.md','timeline-forecast-and-data-states.pdf').replace('database.md','database.pdf')
    headings=re.findall(r'<h2 id="([^"]+)">(.*?)</h2>',body)
    toc=''.join(f'<div class="toc-row"><a href="#{ident}">{name}</a><span class="toc-number" data-heading="{ident}"></span></div>' for ident,name in headings)
    logo='data:image/png;base64,'+base64.b64encode(LOGO.read_bytes()).decode()
    cover=f'''<section class="cover"><img src="{logo}"><div class="eyebrow">{label}</div><h1>EnergieBee core<br>{title}</h1><div class="subtitle">{subtitle}</div><div class="rule"></div><div class="meta">Prepared by Technext<br>Source document · 16 October 2026<br>Report edition · 19 October 2026</div><div class="contact"><b>Technext</b><br><a href="https://technext.it/">technext.it</a> &nbsp; · &nbsp; +1 302 433 6002<br>Wilmington, DE, US 19802-4447</div></section>'''
    content=f'<!doctype html><html><head><meta charset="utf-8"><title>{title} | EnergieBee | Technext</title><style>{CSS}</style></head><body>{cover}<section class="contents"><h2>Contents</h2>{toc}<p class="note">Original technical content and measurement dates are preserved. Diagrams appear on dedicated sheets sized for their detail. The editable Mermaid definitions remain in the source Markdown.</p></section><div class="intro-title">Report overview</div>{body}</body></html>'
    page=browser.new_page()
    page.set_content(content,wait_until='load')
    page.evaluate('document.fonts.ready')
    page.evaluate("""() => {
      for(const t of document.querySelectorAll('table')) {
        if(t.textContent.includes('Comes from') && t.textContent.includes('Saving')) t.style.breakInside='avoid';
      }
      for (const fig of document.querySelectorAll('figure.plate')) {
        const intro=[]; let el=fig.previousElementSibling, count=0;
        while(el && ['H2','H3','H4','P'].includes(el.tagName) && count+el.textContent.length<1200 && intro.length<5){
          intro.unshift(el); count+=el.textContent.length; el=el.previousElementSibling;
        }
        if(intro.some(e=>/^H[234]$/.test(e.tagName) || (e.tagName==='P' && e.children.length===1 && e.firstElementChild.tagName==='STRONG'))){
          const wrapper=document.createElement('div'); fig.insertBefore(wrapper,fig.firstChild);
          intro.forEach(e=>wrapper.appendChild(e));
          const wide=fig.classList.contains('wide');
          const available=(wide?221:337)*96/25.4;
          const used=wrapper.getBoundingClientRect().height+25;
          fig.querySelector('img').style.height=Math.max(350,available-used)+'px';
        }
      }
    }""")
    assert page.locator('img').evaluate_all('(imgs)=>imgs.every(i=>i.complete && i.naturalWidth>0)'), 'Missing image'
    pdf=OUT/f'{slug}.pdf'
    def render():page.pdf(path=str(pdf),print_background=True,prefer_css_page_size=True,outline=True)
    render()
    doc=fitz.open(pdf)
    heading_pages=[]
    for ident,name in headings:
        plain=re.sub('<.*?>','',html.unescape(name))
        match=[]
        for i in range(2,len(doc)):
            heading_text=' '.join(span['text'] for block in doc[i].get_text('dict')['blocks'] if 'lines' in block for line in block['lines'] for span in line['spans'] if span['size'] >= 19)
            if plain in ' '.join(heading_text.split()):match.append(i+1)
        if not match:raise RuntimeError(f'Heading not found: {plain}')
        heading_pages.append((ident,plain,match[0]))
    doc.close()
    for ident,name,n in heading_pages:
        page.locator(f'[data-heading="{ident}"]').evaluate('(e,n)=>e.textContent=n',str(n))
    (OUT/f'{slug}.html').write_text(page.content())
    render(); page.close()
    doc=fitz.open(pdf)
    doc.set_metadata({'title':f'EnergieBee core: {title}','author':'Technext','subject':subtitle,'creator':'Technext report builder'})
    doc.set_toc([[1,'Cover',1],[1,'Contents',2]]+[[1,n,p] for _,n,p in heading_pages])
    for i,p in enumerate(doc):
        w,h=p.rect.width,p.rect.height
        if i:
            p.insert_text((48,30),'TECHNEXT  /  ENERGIEBEE CORE',fontsize=8,color=(.35,.40,.45))
            p.draw_line((48,39),(w-48,39),color=(.85,.88,.90),width=.5)
        p.draw_line((48,h-40),(w-48,h-40),color=(.85,.88,.90),width=.5)
        p.insert_text((48,h-26),'technext.it  |  '+title,fontsize=8,color=(.35,.40,.45))
        p.insert_textbox(fitz.Rect(w-130,h-34,w-48,h-18),f'{i+1} / {len(doc)}',fontsize=8,align=2,color=(.35,.40,.45))
    final=pdf.with_suffix('.final.pdf');doc.save(final,garbage=4,deflate=True);doc.close();final.replace(pdf)
    print(f'{pdf.name}: {len(fitz.open(pdf))} pages; {len(figures)} diagrams',flush=True)

with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless=True)
    for args in CONFIG:build(browser,*args)
    browser.close()
