#!/bin/bash
# Wrapper script for native-host.js
# Chrome may not have access to Homebrew's PATH, so we explicitly set it

# FIRST THING: Log that we started
touch /tmp/whooptido-wrapper-debug.log
echo "$(date): === WRAPPER STARTED ===" >> /tmp/whooptido-wrapper-debug.log

# Log everything for debugging
exec 2>>/tmp/whooptido-wrapper-debug.log
echo "$(date): PATH=$PATH" >> /tmp/whooptido-wrapper-debug.log
echo "$(date): PWD=$PWD" >> /tmp/whooptido-wrapper-debug.log

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "$(date): SCRIPT_DIR=$SCRIPT_DIR" >> /tmp/whooptido-wrapper-debug.log

# Run the native host
echo "$(date): Executing node $SCRIPT_DIR/native-host.js" >> /tmp/whooptido-wrapper-debug.log
exec /opt/homebrew/bin/node "$SCRIPT_DIR/native-host.js"
