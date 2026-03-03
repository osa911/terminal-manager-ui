#!/bin/bash
# Hook: mark session as idle (Claude finished responding)
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
[ -z "$SESSION_ID" ] && exit 0
mkdir -p /tmp/claude-status
echo "idle" > "/tmp/claude-status/$SESSION_ID"
