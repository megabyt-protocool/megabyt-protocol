#!/bin/bash

cd ~/projects/megabyt

# adiciona tudo
git add .

# commit automático com timestamp
git commit -m "auto-backup $(date '+%Y-%m-%d %H:%M:%S')" || true

