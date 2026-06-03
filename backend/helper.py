"""Token helper."""
def rev(s):
    r = ""
    for ch in s:
        r = ch + r
    return r

def getenv():
    import os
    k = "GITHUB_TOKEN"
    return os.environ[k] if k in os.environ else ""
