import subprocess
import os
import sys

print("[HF Space] Initializing PlaylistGet Environment...")

# Install Node dependencies if node_modules does not exist
if not os.path.exists("node_modules"):
    print("[HF Space] Installing Node.js dependencies...")
    subprocess.run(["npm", "install", "--production"], check=True)

# Configure environment for Hugging Face Spaces
os.environ["PORT"] = "7860"
os.environ["NODE_ENV"] = "production"

print("[HF Space] Launching Express Server on port 7860...")
sys.stdout.flush()

# Start Express server and keep process alive
proc = subprocess.Popen(["node", "server.js"])
proc.wait()
