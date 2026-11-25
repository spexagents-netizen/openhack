import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import pngToIco from "png-to-ico";

await mkdir("assets", { recursive: true });
const svg = await readFile("assets/icon.svg");
await sharp(svg).resize(512, 512).png().toFile("assets/icon.png");
await sharp(svg).resize(256, 256).png().toFile("assets/icon-256.png");
await writeFile("assets/icon.ico", await pngToIco("assets/icon-256.png"));
console.log("OpenHack icon set generated");
