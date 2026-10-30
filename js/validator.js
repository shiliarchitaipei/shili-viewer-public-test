/**
 * Contract validator for Viewer schema 1.0
 * Works in both Node.js and Browser environments.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ContractValidator = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function isSafeRelativePath(pathStr) {
    if (typeof pathStr !== 'string' || !pathStr.trim()) return false;
    const trimmed = pathStr.trim();
    // Reject path traversal tokens, absolute paths, windows drive letters, or protocols
    if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return false;
    if (/^[a-zA-Z]:/.test(trimmed)) return false;
    if (trimmed.includes('..')) return false;
    if (/^[a-zA-Z]+:\/\//.test(trimmed)) return false;
    if (trimmed.includes('\\')) return false; // Enforce forward slash relative paths
    // Must contain valid path characters
    return /^[a-zA-Z0-9_\-./]+$/.test(trimmed);
  }

  function isHttpsUrl(urlStr) {
    if (typeof urlStr !== 'string' || !urlStr.trim()) return false;
    const trimmed = urlStr.trim();
    try {
      const u = new URL(trimmed);
      return u.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  function validateContract(data) {
    const errors = [];

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { valid: false, errors: ['Root data must be an object.'] };
    }

    // 1. schemaVersion
    if (data.schemaVersion !== '1.0') {
      errors.push(`Invalid schemaVersion: expected "1.0", received "${data.schemaVersion}"`);
    }

    // 2. revision
    if (typeof data.revision !== 'number' || !Number.isInteger(data.revision) || data.revision < 0) {
      errors.push(`Invalid revision: must be a non-negative integer, received ${data.revision}`);
    }

    const seenIds = new Set();

    // Helper for non-empty string
    function checkNonEmptyString(val, fieldName, context) {
      if (typeof val !== 'string' || !val.trim()) {
        errors.push(`${context}: "${fieldName}" must be a non-empty string.`);
        return false;
      }
      return true;
    }

    // 3. carousel
    if (!Array.isArray(data.carousel)) {
      errors.push('carousel must be an array.');
    } else {
      const seenOrders = new Set();
      data.carousel.forEach((item, idx) => {
        const ctx = `carousel[${idx}]`;
        if (!item || typeof item !== 'object') {
          errors.push(`${ctx} must be an object.`);
          return;
        }

        // id
        if (checkNonEmptyString(item.id, 'id', ctx)) {
          if (seenIds.has(`carousel:${item.id}`)) {
            errors.push(`${ctx}: duplicate id "${item.id}" in carousel.`);
          }
          seenIds.add(`carousel:${item.id}`);
        }

        // title: string (can be empty string)
        if (typeof item.title !== 'string') {
          errors.push(`${ctx}: "title" must be a string (can be empty).`);
        }

        // alt: mandatory non-empty string
        checkNonEmptyString(item.alt, 'alt', ctx);

        // imagePath: safe relative path
        if (!isSafeRelativePath(item.imagePath)) {
          errors.push(`${ctx}: "imagePath" must be a safe relative bundle path without traversal, received "${item.imagePath}".`);
        }

        // targetUrl: HTTPS only
        if (!isHttpsUrl(item.targetUrl)) {
          errors.push(`${ctx}: "targetUrl" must be a valid HTTPS URL, received "${item.targetUrl}".`);
        }

        // order: non-negative integer, unique
        if (typeof item.order !== 'number' || !Number.isInteger(item.order) || item.order < 0) {
          errors.push(`${ctx}: "order" must be a non-negative integer, received ${item.order}.`);
        } else {
          if (seenOrders.has(item.order)) {
            errors.push(`${ctx}: duplicate order ${item.order} in carousel.`);
          }
          seenOrders.add(item.order);
        }

        // enabled: boolean
        if (typeof item.enabled !== 'boolean') {
          errors.push(`${ctx}: "enabled" must be a boolean.`);
        }
      });
    }

    // 4. documents
    if (!Array.isArray(data.documents)) {
      errors.push('documents must be an array.');
    } else {
      data.documents.forEach((item, idx) => {
        const ctx = `documents[${idx}]`;
        if (!item || typeof item !== 'object') {
          errors.push(`${ctx} must be an object.`);
          return;
        }

        // id
        if (checkNonEmptyString(item.id, 'id', ctx)) {
          if (seenIds.has(`document:${item.id}`)) {
            errors.push(`${ctx}: duplicate id "${item.id}" in documents.`);
          }
          seenIds.add(`document:${item.id}`);
        }

        // branchId
        checkNonEmptyString(item.branchId, 'branchId', ctx);

        // title
        checkNonEmptyString(item.title, 'title', ctx);

        // filePath
        if (!isSafeRelativePath(item.filePath)) {
          errors.push(`${ctx}: "filePath" must be a safe relative bundle path without traversal, received "${item.filePath}".`);
        }

        // version
        checkNonEmptyString(item.version, 'version', ctx);
      });
    }

    // 5. news
    if (!Array.isArray(data.news)) {
      errors.push('news must be an array.');
    } else {
      data.news.forEach((item, idx) => {
        const ctx = `news[${idx}]`;
        if (!item || typeof item !== 'object') {
          errors.push(`${ctx} must be an object.`);
          return;
        }

        // id
        if (checkNonEmptyString(item.id, 'id', ctx)) {
          if (seenIds.has(`news:${item.id}`)) {
            errors.push(`${ctx}: duplicate id "${item.id}" in news.`);
          }
          seenIds.add(`news:${item.id}`);
        }

        // title
        checkNonEmptyString(item.title, 'title', ctx);

        // body
        if (typeof item.body !== 'string') {
          errors.push(`${ctx}: "body" must be a string.`);
        }
      });
    }

    // 6. books
    if (!Array.isArray(data.books)) {
      errors.push('books must be an array.');
    } else {
      data.books.forEach((item, idx) => {
        const ctx = `books[${idx}]`;
        if (!item || typeof item !== 'object') {
          errors.push(`${ctx} must be an object.`);
          return;
        }

        // id
        if (checkNonEmptyString(item.id, 'id', ctx)) {
          if (seenIds.has(`book:${item.id}`)) {
            errors.push(`${ctx}: duplicate id "${item.id}" in books.`);
          }
          seenIds.add(`book:${item.id}`);
        }

        // title
        checkNonEmptyString(item.title, 'title', ctx);

        // purchaseUrl: HTTPS only
        if (!isHttpsUrl(item.purchaseUrl)) {
          errors.push(`${ctx}: "purchaseUrl" must be a valid HTTPS URL, received "${item.purchaseUrl}".`);
        }
      });
    }

    return {
      valid: errors.length === 0,
      errors: errors
    };
  }

  return {
    validateContract: validateContract,
    isSafeRelativePath: isSafeRelativePath,
    isHttpsUrl: isHttpsUrl
  };
});
