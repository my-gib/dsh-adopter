// 撞到风控弹窗时的收尾：把短信验证框「取消」掉，清空输入框，不做任何验证。
//
//   node tools/dismiss-verify.mjs
//
// 不点「获取验证码」、不填任何码、不尝试扫码 —— 撞风控就停下来，这是底线。

import { BrowserController } from '../src/browser/controller.mjs';

const controller = new BrowserController({
  source: 'api-probe',
  homeUrl: 'https://www.douyin.com/?recommend=1&from_nav=1',
  readySelector: '',
  allowedOrigins: ['https://www.douyin.com'],
});

try {
  await controller.withPage(async (page) => {
    const state = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return {
        verifyShown: /接收短信验证码|请输入验证码|使用原设备扫码/.test(text),
        stillFilled: [...document.querySelectorAll('.public-DraftEditor-content')].map((element) =>
          (element.innerText || '').replace(/\s+/g, ' ').trim(),
        ),
      };
    });
    console.log('当前状态：', JSON.stringify(state));

    if (state.verifyShown) {
      const cancel = page.getByText('取消', { exact: true }).first();
      const count = await cancel.count();
      console.log('「取消」按钮数量：', count);
      if (count > 0) {
        await cancel.click({ timeout: 8000 }).catch((error) => console.log('点取消失败：', error.message.split('\n')[0]));
        await page.waitForTimeout(1500);
        console.log('已点取消');
      }
    } else {
      console.log('没有看到验证弹窗');
    }

    // 校验：弹窗是否消失
    const after = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return {
        verifyShown: /接收短信验证码|请输入验证码/.test(text),
        stillFilled: [...document.querySelectorAll('.public-DraftEditor-content')].map((element) =>
          (element.innerText || '').replace(/\s+/g, ' ').trim(),
        ),
      };
    });
    console.log('处理后：', JSON.stringify(after));

    // 输入框里残留的字清掉，别让下一次操作捡到旧草稿
    if (after.stillFilled.some((text) => text)) {
      const editors = page.locator('.public-DraftEditor-content');
      if ((await editors.count()) > 0) {
        await editors.first().click({ timeout: 5000 }).catch(() => {});
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await page.waitForTimeout(500);
      }
    }

    const finalState = await page.evaluate(() => ({
      verifyShown: /接收短信验证码|请输入验证码/.test(document.body.innerText || ''),
      editors: [...document.querySelectorAll('.public-DraftEditor-content')].map((element) =>
        (element.innerText || '').replace(/\s+/g, ' ').trim(),
      ),
    }));
    console.log('最终：', JSON.stringify(finalState));

    await page.screenshot({ path: 'logs/verify-dismissed.png' }).catch(() => {});
    console.log('截图：logs/verify-dismissed.png');
  });
} finally {
  await controller.close().catch(() => {});
}
