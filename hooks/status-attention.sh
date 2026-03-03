#!/bin/bash
# Hook: mark session as needing attention (permission prompt, elicitation dialog)
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
[ -z "$SESSION_ID" ] && exit 0
mkdir -p /tmp/claude-status
echo "attention" > "/tmp/claude-status/$SESSION_ID"
