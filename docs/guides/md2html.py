import html, re, sys

def inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    s = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', s)
    s = re.sub(r'(https?://[^\s<)]+)', r'<a href="\1">\1</a>', s)
    return s

def convert(md, title):
    out, lines, i = [], md.split('\n'), 0
    stack = []  # list stack: (type, indent)
    def close_lists(to=0):
        while len(stack) > to:
            t, _ = stack.pop(); out.append(f'</li></{t}>')
    para = []
    def flush():
        if para: out.append('<p>' + inline(' '.join(para)) + '</p>'); para.clear()
    while i < len(lines):
        ln = lines[i]
        m_h = re.match(r'^(#{1,3}) (.*)', ln)
        m_li = re.match(r'^( *)([-*]|\d+\.) (.*)', ln)
        if not ln.strip():
            flush(); i += 1
            # keep lists open across blank lines only if next line continues the list
            nxt = lines[i] if i < len(lines) else ''
            if stack and not re.match(r'^( *)([-*]|\d+\.) ', nxt): close_lists()
            continue
        if m_h:
            flush(); close_lists(); n = len(m_h.group(1))
            out.append(f'<h{n}>{inline(m_h.group(2))}</h{n}>')
        elif ln.strip() == '---':
            flush(); close_lists(); out.append('<hr/>')
        elif ln.startswith('|'):
            flush(); close_lists()
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                rows.append([c.strip() for c in lines[i].strip().strip('|').split('|')]); i += 1
            n=len(rows[0]); w=[45,55] if n==2 else [26,40,34]
            out.append('<table width="100%" border="1" cellspacing="0" cellpadding="5">' + ''.join(f'<col width="{x}%"/>' for x in w) + '<thead><tr>' + ''.join(f'<th>{inline(c)}</th>' for c in rows[0]) + '</tr></thead><tbody>')
            for r in rows[2:]:
                out.append('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>')
            out.append('</tbody></table>'); continue
        elif m_li:
            flush()
            ind, mark, text = len(m_li.group(1)), m_li.group(2), m_li.group(3)
            t = 'ol' if mark[0].isdigit() else 'ul'
            if not stack or ind > stack[-1][1]:
                out.append(f'<{t}><li>'); stack.append((t, ind))
            else:
                while stack and ind < stack[-1][1]:
                    tt, _ = stack.pop(); out.append(f'</li></{tt}>')
                out.append('</li><li>')
            out.append(inline(text))
        else:
            if stack: out.append(' ' + inline(ln.strip()))
            else: para.append(ln.strip())
        i += 1
    flush(); close_lists()
    css = """body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:11pt;line-height:1.4;color:#1a1a1a}
h1,h2,h3{font-family:Arial,Helvetica,sans-serif}h1{font-size:20pt;color:#0b5394;margin-bottom:6pt}h2{font-size:14pt;color:#0b5394;margin-top:14pt}h3{font-size:12pt}
table{border-collapse:collapse;width:100%;margin:6pt 0}th,td{border:1px solid #999;text-align:left;vertical-align:top;font-size:10pt;line-height:1.2;margin:0}
th{background:#e8eef7}code{font-family:Menlo,Consolas,monospace;font-size:9.5pt}hr{border:0;border-top:1px solid #ccc}"""
    return f'<!DOCTYPE html><html><head><meta charset="utf-8"><title>{html.escape(title)}</title><style>{css}</style></head><body>\n' + '\n'.join(out) + '\n</body></html>\n'

src, dst = sys.argv[1], sys.argv[2]
md = open(src, encoding='utf-8').read()
title = md.split('\n', 1)[0].lstrip('# ').strip()
open(dst, 'w', encoding='utf-8').write(convert(md, title))
