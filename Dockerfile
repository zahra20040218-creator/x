# Sandbox for the autonomous agent loop (RUN_AUTONOMOUS.md §1).
#
# The point of this image is blast radius, not convenience. The loop runs with
# --permission-mode bypassPermissions, which means the agent can run any command
# without asking. Inside the container the worst outcome is a ruined container.
# On the host it is every file the user account can write.
#
#   docker build -t rideapp-agent .
#   docker run --rm -v "$PWD":/work rideapp-agent bash run.sh
FROM node:22-slim

RUN npm install -g @anthropic-ai/claude-code \
 && apt-get update && apt-get install -y --no-install-recommends git curl jq ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# claude-code refuses to run as root under bypassPermissions. That refusal is a
# feature; do not work around it by running the loop as root.
RUN useradd -m -s /bin/bash agent
USER agent
WORKDIR /work
