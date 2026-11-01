#!/bin/sh
# Vercel "Ignored Build Step" for the marketing site, wired up as `ignoreCommand`
# in ../vercel.ts. Vercel builds on exit 1 and skips on exit 0.
#
# Production (main) always builds. A preview builds only when apps/marketing
# changed since the branch's last successful deployment, so PRs that only touch
# the app get no preview deploy.
set -u

if [ "${VERCEL_ENV:-}" = "production" ]; then
  echo "Production deploy, building."
  exit 1
fi

# Vercel leaves VERCEL_GIT_PREVIOUS_SHA empty until the branch has a successful
# deployment. Then only the pushed tip commit is checked, because Vercel's
# shallow clone has no main ref to find where the branch started.
base="${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}"
if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  echo "Base commit ${base} is not in the clone (rebase or long branch), building."
  exit 1
fi

# Runs from the Root Directory (apps/marketing), so "." is the site.
changed="$(git diff --name-only "$base" HEAD -- .)" || exit 1

if [ -n "$changed" ]; then
  echo "Marketing site changed since ${base}, building:"
  echo "$changed"
  exit 1
fi

echo "No marketing changes since ${base}, skipping preview."
exit 0
