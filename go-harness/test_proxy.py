import json
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8080/v1", api_key="not-needed")

print("=== 1. Health check ===")
import urllib.request
resp = urllib.request.urlopen("http://localhost:8080/health")
print(json.loads(resp.read()))

print("\n=== 2. List models ===")
models = client.models.list()
for m in models.data:
    print(f"  {m.id}")

print("\n=== 3. Basic chat completion ===")
resp = client.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "Say hello in one sentence."}],
)
print(f"  Response: {resp.choices[0].message.content}")

print("\n=== 4. Streaming chat ===")
stream = client.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "Count from 1 to 3."}],
    stream=True,
)
print("  Stream: ", end="", flush=True)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()

print("\n=== 5. Tool call test ===")
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather in a location",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {"type": "string", "description": "City name"}
                },
                "required": ["location"]
            }
        }
    }
]

try:
    resp = client.chat.completions.create(
        model="gpt-4",
        messages=[{"role": "user", "content": "What's the weather in Tokyo?"}],
        tools=tools,
    )
    msg = resp.choices[0].message
    print(f"  Content: {msg.content}")
    if msg.tool_calls:
        for tc in msg.tool_calls:
            print(f"  Tool call: {tc.function.name}({tc.function.arguments})")
    else:
        print("  No tool calls returned (proxy may not support tools)")
except Exception as e:
    print(f"  Error: {e}")

print("\nDone.")
