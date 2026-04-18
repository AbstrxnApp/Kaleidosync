const puppeteer = require("puppeteer");
(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page1 = await browser.newPage();
  await page1.goto('http://localhost:3000/?room=testsuite');
  
  // Wait for load
  await new Promise(r => setTimeout(r, 2000));
  
  // Simulate drawing on page 1
  await page1.mouse.move(400, 400);
  await page1.mouse.down();
  await page1.mouse.move(500, 500, { steps: 10 });
  await page1.mouse.up();
  
  // Wait for broadcast
  await new Promise(r => setTimeout(r, 1000));
  
  // Open page 2
  const page2 = await browser.newPage();
  await page2.goto('http://localhost:3000/?room=testsuite');
  await new Promise(r => setTimeout(r, 2000));
  
  // Check the metrics text inside page 2
  const metricsText = await page2.evaluate(() => {
    const el = document.querySelector('.whitespace-pre-line');
    return el ? el.innerText : 'Not found';
  });
  console.log("Page 2 Metrics:", metricsText.replace(/\n/g, ' '));
  
  // Evaluate if offscreen canvas has drawn pixels!
  const hasPixels = await page2.evaluate(() => {
     const canvas = document.querySelector('canvas');
     if (!canvas) return "No visible canvas";
     const ctx = canvas.getContext('2d');
     const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
     let sum = 0;
     for(let i=0; i<imgData.length; i+=4) {
        if(imgData[i] > 100 || imgData[i+1] > 100 || imgData[i+2] > 100) { sum++; }
     }
     return `Bright pixels: ${sum}`;
  });
  
  console.log("Page 2 Pixels:", hasPixels);
  
  // Draw something else on page 1 just to see
  await page1.mouse.move(200, 200);
  await page1.mouse.down();
  await page1.mouse.move(300, 300, { steps: 10 });
  await page1.mouse.up();
  
  await new Promise(r => setTimeout(r, 500));
  
  const hasPixels2 = await page2.evaluate(() => {
     const canvas = document.querySelector('canvas');
     const ctx = canvas.getContext('2d');
     const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
     let sum = 0;
     for(let i=0; i<imgData.length; i+=4) {
        if(imgData[i] > 100 || imgData[i+1] > 100 || imgData[i+2] > 100) sum++;
     }
     return `Bright pixels: ${sum}`;
  });
  
  console.log("Page 2 Pixels After Second Draw:", hasPixels2);
  
  process.exit();
})();
