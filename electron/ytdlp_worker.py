# A long-running yt-dlp worker for abyss. Starting yt-dlp for every song costs seconds of Python
# start-up plus re-solving YouTube's player script; this process does that once and then answers
# one JSON request per line on stdin with one JSON line on stdout.
import json
import os
import sys

import yt_dlp

AUDIO = 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best'

ydl = yt_dlp.YoutubeDL({
    'quiet': True,
    'no_warnings': True,
    'noplaylist': True,
    'skip_download': True,
    'format': AUDIO,
    # abyss passes its own executable (Electron in Node mode) so users need no Node install.
    'js_runtimes': {'node': {'path': os.environ['ABYSS_NODE']} if os.environ.get('ABYSS_NODE') else {}},
    # Signed in: the account's session (written by electron/media.js).
    **({'cookiefile': os.environ['ABYSS_COOKIES']} if os.environ.get('ABYSS_COOKIES') else {}),
})


def resolve(video_id):
    info = ydl.extract_info(f'https://music.youtube.com/watch?v={video_id}', download=False)
    fmt = (info.get('requested_downloads') or [info])[0]
    return {
        'url': fmt.get('url') or info.get('url'),
        'headers': fmt.get('http_headers') or info.get('http_headers') or {},
        'ext': fmt.get('ext'),
        'size': fmt.get('filesize') or fmt.get('filesize_approx') or 0,
    }


print(json.dumps({'ready': True, 'version': yt_dlp.version.__version__}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
    except ValueError:
        continue
    try:
        out = {'seq': req['seq'], **resolve(req['id'])}
    except Exception as e:  # noqa: BLE001 — every failure goes back to the app as a message
        out = {'seq': req.get('seq'), 'error': str(e).strip().splitlines()[-1] if str(e).strip() else type(e).__name__}
    print(json.dumps(out), flush=True)
