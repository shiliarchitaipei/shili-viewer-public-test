/**
 * Offline PDF Binary Format Checker (Sanity Checker)
 * 
 * 範圍與定位釐清 (Scope Clarification):
 * 本模組僅為「輕量級二進位格式健全度檢查器 (Lightweight Binary Format Checker)」，
 * 檢查 %PDF- 標頭、%%EOF 標記與字典結構，提供基本的損毀與防誤判降級信號。
 * 本模組【絕非】成熟完整的通用 PDF 解析與 Canvas 渲染引擎 (PDF.js 等級)。
 * 核心成熟 PDF 解析渲染層因離線無網環境限制列為「未完成 (BLOCKED / INCOMPLETE)」。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PdfInspector = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * 執行有限格式健全度檢查 (Sanity check only, not a universal PDF engine)
   * @param {ArrayBuffer|Uint8Array|Buffer} buffer
   * @returns {{ valid: boolean, estimatedPages: number, error: string|null, isBasicSanityCheck: boolean }}
   */
  function inspectPdf(buffer) {
    if (!buffer) {
      return { valid: false, estimatedPages: 0, error: 'Empty buffer provided', isBasicSanityCheck: true };
    }

    let bytes;
    if (buffer instanceof Uint8Array) {
      bytes = buffer;
    } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(buffer)) {
      bytes = new Uint8Array(buffer);
    } else if (buffer instanceof ArrayBuffer) {
      bytes = new Uint8Array(buffer);
    } else {
      return { valid: false, estimatedPages: 0, error: 'Unsupported buffer type', isBasicSanityCheck: true };
    }

    if (bytes.length < 32) {
      return { valid: false, estimatedPages: 0, error: 'File too small to be a valid PDF document', isBasicSanityCheck: true };
    }

    function bytesToString(slice) {
      let str = '';
      for (let i = 0; i < slice.length; i++) {
        str += String.fromCharCode(slice[i]);
      }
      return str;
    }

    // 1. 標頭檢查 (Header Check)
    const headerLimit = Math.min(bytes.length, 1024);
    const headerStr = bytesToString(bytes.subarray(0, headerLimit));
    if (!headerStr.includes('%PDF-')) {
      return { valid: false, estimatedPages: 0, error: '格式檢查失敗: 遺失 %PDF- 標頭 (非合法 PDF 或檔案損毀)', isBasicSanityCheck: true };
    }

    // 2. 結尾檢查 (Trailer Check)
    const tailStart = Math.max(0, bytes.length - 2048);
    const tailStr = bytesToString(bytes.subarray(tailStart));
    if (!tailStr.includes('%%EOF')) {
      return { valid: false, estimatedPages: 0, error: '格式檢查失敗: 遺失 %%EOF 結尾標記 (檔案損毀或傳輸不完整)', isBasicSanityCheck: true };
    }

    // 3. 頁數概估 (僅供有限介面指示，非成熟光柵化引擎解碼)
    const fullStr = bytesToString(bytes);
    const countMatches = [...fullStr.matchAll(/\/Count\s+(\d+)/g)];
    if (countMatches.length > 0) {
      const counts = countMatches.map(m => parseInt(m[1], 10)).filter(n => !isNaN(n) && n > 0);
      if (counts.length > 0) {
        return { valid: true, estimatedPages: Math.max(...counts), error: null, isBasicSanityCheck: true };
      }
    }

    const pageMatches = [...fullStr.matchAll(/\/Type\s*\/Page\b(?!\s*s)/g)];
    if (pageMatches.length > 0) {
      return { valid: true, estimatedPages: pageMatches.length, error: null, isBasicSanityCheck: true };
    }

    return {
      valid: false,
      estimatedPages: 0,
      error: '格式檢查失敗: 未能識別基本頁面結構字典 (/Pages 或 /Page)',
      isBasicSanityCheck: true
    };
  }

  return {
    inspectPdf: inspectPdf
  };
});
