[![Backroads by kevinschaich](https://kevinschaich.com/og/backroads.png)](https://kevinschaich.com/project/backroads/)

# Backroads

Find the roads worth driving, anywhere.

**[Try it →](https://kevinschaich.com/project/backroads/)**

## How it works

- 🟢 **Great**: few stops, open land alongside, curves or hills
- 🟡 **OK**: freeways and plain roads
- 🔴 **Bad**: stoplight-and-strip-mall arterials and neighborhood streets

As you pan, the page fetches OpenStreetMap roads for the areas in view and scores them in the browser.
Each road is measured over about a mile of the same street: lights and stops, turn-offs, buildings,
commercial frontage, open land (ESA WorldCover), curves and hills (Mapterhorn elevation). Speeds are
never guessed: a posted limit is used only where OpenStreetMap has one. Tap any road to see its
measurements and why it got its color.

## Run locally

```sh
python3 -m http.server 8765 -d live
```
