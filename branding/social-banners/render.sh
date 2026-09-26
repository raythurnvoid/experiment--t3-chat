#!/usr/bin/env bash
# Render the banner in each format with headless Chrome.
cd "$(dirname "$0")"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
URL="file:///$(pwd -W)/banner.html"
render() {
	"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
		--window-size="$2" --virtual-time-budget=8000 --screenshot="$(pwd -W)/$3" "$URL?f=$1" 2>/dev/null
}
render yt 2560,1440 banner-youtube-2560x1440.png
render x 1500,500 banner-x-1500x500.png
render li 1584,396 banner-linkedin-1584x396.png
ls -la *.png
