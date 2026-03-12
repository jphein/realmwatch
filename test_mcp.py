import asyncio
import os
import json
from mcp.client.session import ClientSession
from mcp.client.stdio import stdio_client, StdioServerParameters

async def run_test():
    server_params = StdioServerParameters(
        command="/home/jp/Projects/lit-rpg-fantasy-voice/venv/bin/python3",
        args=["/home/jp/Projects/lit-rpg-fantasy-voice/server.py"]
    )
    
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            
            # Test Tools
            print("--- Testing list_tools ---")
            tools = await session.list_tools()
            for t in tools.tools:
                print(f"Tool: {t.name} - {t.description}")
            
            print("\n--- Testing get_system_status ---")
            status = await session.call_tool("get_system_status", {})
            print(status.content[0].text)
            
            # Test Prompts
            print("\n--- Testing list_prompts ---")
            prompts = await session.list_prompts()
            for p in prompts.prompts:
                print(f"Prompt: {p.name} - {p.description}")
            
            print("\n--- Testing get_prompt (system-persona) ---")
            persona_prompt = await session.get_prompt("system-persona", {})
            print(f"Content:\n{persona_prompt.messages[0].content.text}")

            # Test Resources
            print("\n--- Testing list_resources ---")
            resources = await session.list_resources()
            for r in resources.resources:
                print(f"Resource: {r.uri} - {r.name}")
            
            print("\n--- Testing read_resource (system://sensors/status) ---")
            res_content = await session.read_resource("system://sensors/status")
            print(res_content)

            print("\n--- Testing vocalize_message ---")
            voc = await session.call_tool("vocalize_message", {"text": "The System is fully updated."})
            print(f"Vocalize: {voc.content[0].text}")

            print("\n--- Testing commune_with_system ---")
            com = await session.call_tool("commune_with_system", {})
            print(f"Commune: {com.content[0].text}")

if __name__ == "__main__":
    asyncio.run(run_test())
