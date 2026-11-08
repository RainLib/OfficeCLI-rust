import browserInit from 'ironpress';
import nodeInit, { HtmlConverter, htmlToPdf } from 'ironpress/node';

async function render(): Promise<Uint8Array> {
  await nodeInit();
  const converter = new HtmlConverter();
  converter.pageSize('Letter');
  converter.free();
  return htmlToPdf('<h1>Typed Node.js consumer</h1>');
}

void browserInit;
void render;
