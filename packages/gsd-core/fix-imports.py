#!/usr/bin/env python3
"""Fix import paths after moving files to a subdirectory.

Usage: python3 fix-imports.py <domain> <file1> <file2> ...

Example: python3 fix-imports.py verification verification-evidence verification-gate

This script:
1. Fixes imports INSIDE moved files (./foo.js → ../foo.js for non-siblings)
2. Fixes imports in EXTERNAL consumers (./foo.js → ./domain/foo.js, ../foo.js → ../domain/foo.js)
3. Handles: from "..." imports, dynamic import("..."), and inline import("...").Type references
"""

import re
import sys
import os
import glob

def fix_file(filepath: str, find: str, replace: str) -> bool:
    """Replace all occurrences of find with replace in filepath. Returns True if changed."""
    with open(filepath) as f:
        content = f.read()
    new_content = content.replace(find, replace)
    if new_content != content:
        with open(filepath, 'w') as f:
            f.write(new_content)
        return True
    return False

def main():
    domain = sys.argv[1]
    files = sys.argv[2:]  # basenames without .ts

    src_dir = os.path.dirname(os.path.abspath(__file__)) + '/src'
    domain_dir = os.path.join(src_dir, domain)

    siblings = set(files)

    # Step 1: Fix imports INSIDE moved files
    print(f"\n=== Fixing imports inside {domain}/ ===")
    for f in files:
        fpath = os.path.join(domain_dir, f + '.ts')
        if not os.path.exists(fpath):
            print(f"  SKIP (not found): {fpath}")
            continue

        with open(fpath) as fh:
            content = fh.read()

        original = content

        # Match all string references: from "...", from '...', import("..."), import('...')
        def fix_internal_ref(m):
            prefix = m.group(1)  # from or import(
            quote = m.group(2)   # ' or "
            path = m.group(3)    # the path
            end_quote = m.group(4)  # ' or "

            # Ensure matching quotes
            if quote != end_quote:
                return m.group(0)

            if not path.startswith('./'):
                return m.group(0)

            # Get the basename (without .js/.ts extension and ./ prefix)
            basename = path[2:].replace('.js', '').replace('.ts', '').split('/')

            # If it's a sibling import (same domain), leave it
            if len(basename) == 1 and basename[0] in siblings:
                return m.group(0)

            # Change ./ to ../
            new_path = '../' + path[2:]
            return f'{prefix}{quote}{new_path}{end_quote}'

        content = re.sub(
            r'''(from\s+|import\()(["'])(\.\/[^"']+)(["'])''',
            fix_internal_ref,
            content
        )

        if content != original:
            with open(fpath, 'w') as fh:
                fh.write(content)
            print(f"  Fixed: {f}.ts")

    # Step 2: Fix imports in EXTERNAL consumers
    print(f"\n=== Fixing external consumers ===")

    # Collect all .ts files recursively
    all_ts = []
    for root, dirs, fnames in os.walk(src_dir):
        # Skip the domain directory itself (already fixed)
        rel = os.path.relpath(root, src_dir)
        if rel == domain or rel.startswith(domain + '/'):
            continue
        for fname in fnames:
            if fname.endswith('.ts'):
                all_ts.append(os.path.join(root, fname))

    for ts_file in sorted(all_ts):
        rel_dir = os.path.relpath(os.path.dirname(ts_file), src_dir)
        depth = 0 if rel_dir == '.' else rel_dir.count('/') + 1

        changed = False
        for basename in files:
            # Figure out old and new import paths based on consumer depth
            if depth == 0:
                # Root-level consumer: ./foo.js → ./domain/foo.js
                for ext in ['.js', '.ts']:
                    old_ref = f'./{basename}{ext}'
                    new_ref = f'./{domain}/{basename}.js'
                    if fix_file(ts_file, old_ref, new_ref):
                        changed = True
            else:
                # Subdir consumer: need to figure out how many ../ to get to root
                prefix = '../' * depth
                for ext in ['.js', '.ts']:
                    old_ref = f'{prefix}{basename}{ext}'
                    new_ref = f'{prefix}{domain}/{basename}.js'
                    if fix_file(ts_file, old_ref, new_ref):
                        changed = True

        if changed:
            short = os.path.relpath(ts_file, src_dir)
            print(f"  Fixed: {short}")

if __name__ == '__main__':
    main()
