"""Ask the small language model for one letter, A to E."""
from .config import CONFIG
from .client import post

URL = f"http://127.0.0.1:{CONFIG['LLM_PORT']}/v1/chat/completions"

# Keep the system prompt stable: llama-server caches the start of the prompt,
# so text that never changes is only read once.
SYSTEM = ("You solve multiple-choice math competition problems for school students. "
          "Read the problem and the options, then reply with the letter of the correct option.")


def format_problem(problem, sees_image=False):
    lines = [problem["text"].strip()]
    options = problem.get("options") or {}
    for letter in "ABCDE":
        if letter in options:
            lines.append(f"{letter}) {options[letter]}")
    if not options:
        lines.append("(The options are in the picture.)" if sees_image else
                     "(The options are in a picture that you can't see. Pick the most likely letter.)")
    return "\n".join(lines)


def build_messages(problem, examples=(), image_b64=None):
    """image_b64 is a PNG as base64 text. Only a server started with --mmproj can see it."""
    messages = [{"role": "system", "content": SYSTEM}]
    for ex in examples:  # solved problems retrieved with RAG, if any
        messages.append({"role": "user", "content": format_problem(ex) + "\nAnswer:"})
        messages.append({"role": "assistant", "content": ex["label"]})
    text = format_problem(problem, sees_image=bool(image_b64)) + "\nAnswer:"
    if image_b64:
        content = [{"type": "image_url", "image_url": {"url": "data:image/png;base64," + image_b64}},
                   {"type": "text", "text": text}]
    else:
        content = text
    messages.append({"role": "user", "content": content})
    return messages


def answer_letter(problem, examples=(), timeout=60, image_b64=None, url=URL,
                  with_scores=False, top_logprobs=512):
    """Return (letter, timings), plus raw A-E logprobs when requested.

    llama.cpp reports top_logprobs before applying the grammar. Asking for a
    wider set lets us find all five letter tokens, even when words rank higher.
    """
    payload = {
        "messages": build_messages(problem, examples, image_b64),
        "grammar": "root ::= [A-E]",
        "max_tokens": 1,
        "temperature": 0,
        "seed": int(CONFIG["SEED"]),
        "cache_prompt": True,
    }
    if with_scores:
        payload.update(logprobs=True, top_logprobs=top_logprobs)
    response = post(url, payload, timeout=timeout)
    letter = response["choices"][0]["message"]["content"].strip()
    timings = response.get("timings", {})
    if not with_scores:
        return letter, timings
    entries = response["choices"][0].get("logprobs", {}).get("content") or []
    top = entries[0].get("top_logprobs", []) if entries else []
    scores = {item["token"]: item["logprob"] for item in top
              if item.get("token") in "ABCDE" and len(item.get("token", "")) == 1
              and "logprob" in item}
    return letter, timings, scores
