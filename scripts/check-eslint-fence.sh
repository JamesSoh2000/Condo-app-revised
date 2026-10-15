#!/usr/bin/env bash
# Self-test for the ESLint Base44 fence (ADR-0011, ADR-0015). Today no file under src/features or src/app
# exists, so `eslint .` alone would pass even if the fence were misconfigured or crashed. This pipes known
# variants through eslint (nothing is written to disk) and checks that the fence fires, or stays quiet.
# Usage: bash scripts/check-eslint-fence.sh   (from anywhere in the repo; needs frontend/node_modules)
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../frontend"
# Severity 2 = "error". A rule downgraded to "warn" must count as missing: CI runs eslint --quiet.
fence='"ruleId":"(no-restricted-imports|no-restricted-syntax)","severity":2'
hooks='"ruleId":"react-hooks/rules-of-hooks","severity":2'
failures=0

check() { # $1 = fence|hooks|none, $2 = filename eslint should assume, $3 = code
  local out status got
  out="$(printf '%s\n' "$3" | npx eslint --stdin --stdin-filename "$2" -f json 2>&1)"
  status=$?
  if (( status > 1 )); then
    got="eslint crashed: ${out:0:200}"
  elif grep -qE "$fence" <<<"$out"; then
    got=fence
  elif grep -qE "$hooks" <<<"$out"; then
    got=hooks
  else
    got=none
  fi
  if [[ $got == "$1" ]]; then
    printf 'ok    %-5s %-22s %s\n' "$1" "$2" "$3"
  else
    printf 'FAIL  expected %s, got %s: %s  %s\n' "$1" "$got" "$2" "$3"
    failures=$((failures + 1))
  fi
}

# Base44 must not reach new code, however it is imported.
check fence src/features/x.ts "import { base44 } from '@/api/base44Client'; export { base44 };"
check fence src/features/x.ts "import { base44 } from '@/api/base44Client.js'; export { base44 };"
check fence src/features/x.ts "import { base44 } from '../api/base44Client.js'; export { base44 };"
check fence src/features/x.ts "import { User } from '@/api/entities'; export { User };"
check fence src/features/x.ts "import { InvokeLLM } from '@/api/integrations'; export { InvokeLLM };"
check fence src/features/x.ts "import { User } from '../../api/entities.js'; export { User };"
check fence src/features/x.ts "export * from '@/api/integrations';"
check fence src/features/x.ts "export const m = () => import('@/api/base44Client');"
check fence src/features/x.ts "export const s = require('@/api/base44Client');"
check fence src/features/x.ts "export const t = () => import(\`@/api/base44Client\`);"
check fence src/features/x.tsx "import { createClient } from '@base44/sdk'; export { createClient };"
check fence src/app/y.jsx "export const m = () => import('@base44/sdk');"
check fence src/app/y.js "import { base44 } from '@/api/base44Client.js'; export { base44 };"
# TypeScript files get the same hooks rule as legacy JSX.
check hooks src/features/h.tsx "import { useState } from 'react'; export function A({ c }: { c: boolean }) { if (c) { useState(0); } return null; }"
# Ordinary imports in new code, and Base44 in legacy pages, stay allowed.
check none src/features/ok.ts "import { useQuery } from '@tanstack/react-query'; export const q = useQuery;"
check none src/features/ok2.ts "export const lazy = () => import('./other');"
check none src/features/ok3.ts "import { api } from '@/api/client'; export { api };"
check none src/pages/Legacy.jsx "import { base44 } from '@/api/base44Client'; export const l = base44;"

if (( failures > 0 )); then
  echo "::error::$failures ESLint fence check(s) failed (frontend/eslint.config.js)." >&2
  exit 1
fi
echo "ESLint fence: all checks passed."
