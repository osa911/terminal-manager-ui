#!/bin/bash
# Hook: mark session as active
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
[ -z "$SESSION_ID" ] && exit 0
mkdir -p /tmp/claude-status
echo "active" > "/tmp/claude-status/$SESSION_ID"
