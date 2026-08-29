import dashscope
import base64
import json
import ssl
import urllib3

ssl._create_default_https_context = ssl._create_unverified_context
urllib3.disable_warnings()

dashscope.api_key = "sk-ws-H.DDMDXRM.JO5j.MEUCIQCUsfLgYHUQzix8wE1ZoZDVTOAh2BFunfQbL8sFRM9sCwIgCqCTvp6nhcoXA3yNGr4pyF8-dn6AibGC-MXrddoizmY"

def test_rule(image_path, rule):
    with open(image_path, "rb") as f:
        image_data = base64.b64encode(f.read()).decode("utf-8")
    
    prompt = f"""Rule: {rule}
Does this image violate the rule?
Respond ONLY with this exact JSON:
{{"triggered": true or false, "explanation": "one sentence", "confidence": 0.0 to 1.0}}"""
    
    response = dashscope.MultiModalConversation.call(
        model="qwen-vl-max",
        messages=[{
            "role": "user",
            "content": [
                {"image": f"data:image/png;base64,{image_data}"},
                {"text": prompt}
            ]
        }]
    )
    
    result = response.output.choices[0].message.content[0]["text"]
    print(f"Rule: {rule}")
    print(f"Result: {result}\n")

print("--- Test 1: Empty room ---")
test_rule("empty.png", "Is there a person in this frame?")

print("--- Test 2: Reaching ---")
test_rule("reaching.png", "Is a person reaching toward an object?")
