/**
 * Correlation ID Middleware — Request Tracing
 *
 * Assigns a unique request ID to every incoming request. If the client provides
 * an x-request-id header, that value is used; otherwise a new UUID is generated.
 *
 * All logs and metrics for this request should include the correlation ID so that
 * related operations can be grouped and traced across services.
 *
 * Usage:
 *   app.use(correlationIdMiddleware());
 *   // Then in any handler: req.id contains the correlation ID
 */

const { v4: uuid } = require('uuid');

/**
 * Express middleware that attaches a correlation ID to every request.
 *
 * Headers:
 *   - Input: x-request-id (optional, client-provided)
 *   - Output: x-request-id (always set in response)
 *
 * Properties:
 *   - req.id: Correlation ID for this request
 *   - res.locals.requestId: Same value, accessible in templates
 */
function correlationIdMiddleware() {
  return (req, res, next) => {
    // Accept client-provided correlation ID if present, otherwise generate
    const correlationId = req.headers['x-request-id'] || uuid();

    // Attach to request and response locals
    req.id = correlationId;
    res.locals.requestId = correlationId;

    // Echo back to client so they can use it for support / debugging
    res.setHeader('x-request-id', correlationId);

    // Log the start of the request
    const method = req.method;
    const path = req.path;
    const query = Object.keys(req.query).length > 0 ? JSON.stringify(req.query) : '';
    const userAgent = req.headers['user-agent'] || 'unknown';
    const clientIp = req.ip || 'unknown';

    console.log(`[${correlationId}] ${method} ${path} ${query} | ip=${clientIp} ua=${userAgent.substring(0, 40)}`);

    // Log the response when it finishes
    const originalEnd = res.end;
    res.end = function(...args) {
      const statusCode = res.statusCode;
      const responseTime = Date.now() - req._startTime;
      console.log(`[${correlationId}] → ${statusCode} ${responseTime}ms`);
      return originalEnd.apply(res, args);
    };

    // Record start time for response timing
    req._startTime = Date.now();

    next();
  };
}

module.exports = { correlationIdMiddleware };
