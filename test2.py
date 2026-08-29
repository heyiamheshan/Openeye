import base64
import ssl
import httpx2 as httpx
from openai import OpenAI, APIError

BASE_URL = "https://ws-35ixz31v8gg9i0vs.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"
API_KEY = "sk-ws-H.DDMHIRH.qpJz.MEUCIQCyfGxKyoVnBpBPdARX2IVhiSDhz7RU2zx6ZnWMb3467QIgdhHAYormXAQMXDjkVzVGzh7QvcJcVEE0Md0yUqm4thg"
MODEL = "qwen-vl-max"


def encode_image(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def make_client(verify_ssl=True):
    http_client = httpx.Client(verify=verify_ssl, timeout=30.0)
    return OpenAI(base_url=BASE_URL, api_key=API_KEY, http_client=http_client, timeout=30.0)


def ask_about_image(client, image_path, rule):
    image_b64 = encode_image(image_path)
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": rule},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{image_b64}"},
                    },
                ],
            }
        ],
    )
    return response.choices[0].message.content


def query_with_fallback(image_path, rule):
    try:
        client = make_client(verify_ssl=True)
        return ask_about_image(client, image_path, rule)
    except (ssl.SSLError, httpx.ConnectError) as e:
        print(f"  [warning] SSL verification failed ({e}); retrying with verification disabled...")
        try:
            client = make_client(verify_ssl=False)
            return ask_about_image(client, image_path, rule)
        except Exception as e2:
            raise RuntimeError(f"Request failed even with SSL verification disabled: {e2}") from e2


def main():
    tests = [
        ("empty.png", "Is there a person in this frame?"),
        ("reaching.png", "Is a person reaching toward an object?"),
    ]

    for image_path, rule in tests:
        print(f"Image: {image_path}")
        print(f"Rule: {rule}")
        try:
            answer = query_with_fallback(image_path, rule)
            print(f"Response: {answer}")
        except FileNotFoundError:
            print(f"Error: image file '{image_path}' was not found.")
        except APIError as e:
            print(f"API error: {e}")
        except Exception as e:
            print(f"Unexpected error: {e}")
        print("-" * 60)


if __name__ == "__main__":
    main()
