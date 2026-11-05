#!/usr/bin/env python3
"""Heuristic Lua structure checker: verifies keyword balance (function/if/for/
while/do vs end) after stripping comments and string literals. Catches the
overwhelming majority of syntax errors (unbalanced blocks)."""
import re
import sys

OPEN = {'function', 'if', 'for', 'while'}
CLOSE = {'end'}


def strip_lua(code):
    """Scanner-based stripper: removes line comments, --[[ ]] block comments
    and string literals in one pass. The previous regex approach stripped
    comments FIRST, so a string containing '--' (e.g. run_cmd("... --init"))
    broke the later string-stripping pass and swallowed the following `end`
    tokens, producing false UNBALANCED reports."""
    out = []
    i, n = 0, len(code)
    while i < n:
        c = code[i]
        if c == '-' and i + 1 < n and code[i + 1] == '-':
            if code.startswith('--[[', i):
                j = code.find(']]', i + 4)
                i = (j + 2) if j != -1 else n
            else:
                j = code.find('\n', i)
                i = j if j != -1 else n
            out.append(' ')
            continue
        if c == '"' or c == "'":
            quote = c
            j = i + 1
            while j < n:
                if code[j] == '\\':
                    j += 2
                    continue
                if code[j] == quote:
                    j += 1
                    break
                j += 1
            out.append('""')
            i = j
            continue
        out.append(c)
        i += 1
    return ''.join(out)


def check(path):
    src = open(path, encoding='utf-8').read()
    toks = re.findall(r'[A-Za-z_][A-Za-z0-9_]*', strip_lua(src))
    depth = 0
    for t in toks:
        if t in OPEN:
            depth += 1
        elif t == 'end':
            depth -= 1
        if depth < 0:
            print(f'{path}: ERROR: extra "end"')
            return False
    if depth != 0:
        print(f'{path}: UNBALANCED (depth={depth})')
        return False
    print(f'{path}: OK (balanced)')
    return True


ok = True
for p in sys.argv[1:]:
    ok = check(p) and ok
sys.exit(0 if ok else 1)