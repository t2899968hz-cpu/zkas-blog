# ZKas blog

Small Node service powering the ZKas blog and its Markdown admin panel.

- Public: `/blogs` (index), `/blog/<slug>` (post), `/blog/feed.xml` (RSS)
- Admin: `/blog/admin` (password login → Markdown editor, image upload, draft/publish)

Storage is file-based (no DB): one JSON per post under `$ZB_STATE_DIR/posts`,
images under `$ZB_MEDIA_DIR` (served by nginx at `/blog-media/`). Secrets in
`$ZB_STATE_DIR/secrets.json` (mode 600).

## Run
```
npm install
node setup.js          # generates the admin password (shown once) + secrets.json
node server.js         # listens on 127.0.0.1:8530
```
Env: `ZB_PORT` (8530), `ZB_STATE_DIR` (/root/zkas-blog), `ZB_MEDIA_DIR` (/var/www/zkas-blog-media).

nginx proxies `/blogs`, `/blog/`, `/blog` and serves `/blog-media/` from disk.
Runs under systemd as `zkas-blog.service`.
