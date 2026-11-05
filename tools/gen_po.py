#!/usr/bin/env python3
"""Generate the zh_Hans po (identity translation) from the pot template."""
import os

here = os.path.dirname(os.path.abspath(__file__))
pot = os.path.join(here, '..', 'po', 'templates', 'tempmon.pot')
po = os.path.join(here, '..', 'po', 'zh_Hans', 'tempmon.po')

src = open(pot, encoding='utf-8').read()
out = []
for block in src.split('\n\n'):
    lines = [l for l in block.strip().split('\n') if l.strip()]
    if not lines or not lines[0].startswith('msgid'):
        continue
    if lines[0] == 'msgid ""':
        out.append('msgid ""\nmsgstr "Content-Type: text/plain; charset=UTF-8"')
        continue
    out.append(lines[0] + '\n' + lines[0].replace('msgid', 'msgstr', 1))

open(po, 'w', encoding='utf-8').write('\n\n'.join(out) + '\n')
print('wrote', po, len(out), 'entries')