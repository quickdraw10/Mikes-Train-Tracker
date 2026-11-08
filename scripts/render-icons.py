# Renders app/icon.svg to the PNG icons iPhones and Android need.
#   python3 scripts/render-icons.py      (needs: pip install playwright && playwright install chromium)
# The Apple icon is drawn full-bleed (square corners) because iOS rounds the corners itself.
import asyncio, pathlib
from playwright.async_api import async_playwright

APP = pathlib.Path(__file__).resolve().parent.parent / 'app'
SVG = (APP / 'icon.svg').read_text()

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for size, name, square in [(512, 'icon-512.png', False), (192, 'icon-192.png', False), (180, 'apple-touch-icon.png', True)]:
            svg = SVG.replace('<svg ', f'<svg width="{size}" height="{size}" ', 1)
            if square:
                svg = svg.replace('<rect id="bg" width="512" height="512" rx="112"', '<rect id="bg" width="512" height="512" rx="0"')
            pg = await b.new_page(viewport={'width': size, 'height': size})
            await pg.set_content(f'<html><body style="margin:0;background:transparent">{svg}</body></html>')
            await pg.screenshot(path=str(APP / name), omit_background=True)
        await b.close()

asyncio.run(main())
