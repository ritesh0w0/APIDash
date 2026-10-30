// backend/services/emailService.js
'use strict';

const nodemailer = require('nodemailer');
const { loadConfig } = require('../config');
const { logger: defaultLogger } = require('../logger');

/**
 * Escapes HTML characters in strings for safe email rendering.
 *
 * @param {string} str
 * @returns {string}
 */
function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class EmailService {
  /**
   * @param {Object} [options]
   * @param {Object} [options.config]
   * @param {import('pino').Logger} [options.logger]
   * @param {import('nodemailer').Transporter} [options.transporter]
   */
  constructor(options = {}) {
    this.config = options.config || loadConfig();
    this.logger = options.logger || defaultLogger;
    this._transporter = options.transporter || null;
  }

  /**
   * Returns or lazily constructs the nodemailer transporter.
   *
   * @returns {import('nodemailer').Transporter|null}
   */
  getTransporter() {
    if (this._transporter) {
      return this._transporter;
    }

    const { smtp } = this.config;
    if (!smtp || !smtp.isConfigured) {
      return null;
    }

    const transportOpts = {
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      connectionTimeout: smtp.connectionTimeoutMs || 10000,
      greetingTimeout: smtp.greetingTimeoutMs || 10000,
      socketTimeout: smtp.socketTimeoutMs || 15000,
    };

    if (smtp.user) {
      transportOpts.auth = {
        user: smtp.user,
        pass: smtp.pass,
      };
    }

    this._transporter = nodemailer.createTransport(transportOpts);
    return this._transporter;
  }

  /**
   * Builds sanitized HTML and text content for incident opening and resolution emails.
   * Never includes raw response bodies, auth headers, or credentials.
   *
   * @param {Object} params
   * @param {string} params.eventType - 'incident_opened' | 'incident_resolved'
   * @param {Object} params.payload
   * @param {string} params.appOrigin
   * @returns {{ subject: string, text: string, html: string }}
   */
  buildEmailContent({ eventType, payload, appOrigin }) {
    const isOpened = eventType === 'incident_opened';
    const monitorName = payload.api_name || `Monitor #${payload.api_id}`;
    const monitorUrl = payload.api_url || '';
    const incidentId = payload.incident_id;
    const dashboardLink = `${appOrigin}/#incidents`;

    if (isOpened) {
      const subject = `[ALERT] Incident Opened: ${monitorName} is DOWN`;
      const openedAt = payload.opened_at ? new Date(payload.opened_at).toUTCString() : 'Just now';
      const firstUnhealthyAt = payload.first_unhealthy_at ? new Date(payload.first_unhealthy_at).toUTCString() : openedAt;
      const errorSummary = payload.error_summary || 'Consecutive monitoring checks failed.';

      const text = [
        `ALERT: Incident Opened for "${monitorName}"`,
        ``,
        `Status: OPEN`,
        `Monitor URL: ${monitorUrl}`,
        `First Unhealthy: ${firstUnhealthyAt}`,
        `Detected At: ${openedAt}`,
        `Failure Reason: ${errorSummary}`,
        `Incident ID: #${incidentId}`,
        ``,
        `View incident in dashboard: ${dashboardLink}`,
      ].join('\n');

      const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b0f19; color: #f3f4f6; padding: 24px;">
  <div style="max-width: 600px; margin: 0 auto; background: #131b2e; border: 1px solid #dc2626; border-radius: 8px; padding: 24px;">
    <div style="display: flex; align-items: center; margin-bottom: 16px;">
      <span style="background: #dc2626; color: white; padding: 4px 10px; border-radius: 4px; font-weight: bold; font-size: 13px; text-transform: uppercase;">Incident Opened</span>
      <span style="color: #9ca3af; margin-left: 12px; font-size: 14px;">Incident #${escHtml(incidentId)}</span>
    </div>
    <h2 style="margin: 0 0 12px 0; color: #ffffff; font-size: 20px;">${escHtml(monitorName)} is DOWN</h2>
    <p style="color: #9ca3af; font-size: 14px; margin: 0 0 16px 0;">The monitor reached 2 consecutive unhealthy observations.</p>
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 14px;">
      <tr><td style="padding: 8px 0; color: #9ca3af; width: 140px;">Endpoint:</td><td style="padding: 8px 0; color: #f3f4f6; font-family: monospace;">${escHtml(monitorUrl)}</td></tr>
      <tr><td style="padding: 8px 0; color: #9ca3af;">First Unhealthy:</td><td style="padding: 8px 0; color: #f3f4f6;">${escHtml(firstUnhealthyAt)}</td></tr>
      <tr><td style="padding: 8px 0; color: #9ca3af;">Detected At:</td><td style="padding: 8px 0; color: #f3f4f6;">${escHtml(openedAt)}</td></tr>
      <tr><td style="padding: 8px 0; color: #9ca3af;">Failure Summary:</td><td style="padding: 8px 0; color: #ef4444; font-weight: 500;">${escHtml(errorSummary)}</td></tr>
    </table>
    <a href="${escHtml(dashboardLink)}" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; font-size: 14px;">View Incident in Dashboard</a>
  </div>
</body>
</html>`;

      return { subject, text, html };
    } else {
      const subject = `[RESOLVED] Incident Resolved: ${monitorName} is BACK UP`;
      const resolvedAt = payload.resolved_at ? new Date(payload.resolved_at).toUTCString() : 'Just now';

      const text = [
        `RESOLVED: Incident Resolved for "${monitorName}"`,
        ``,
        `Status: RESOLVED`,
        `Monitor URL: ${monitorUrl}`,
        `Resolved At: ${resolvedAt}`,
        `Consecutive Passing Checks: 2 required and verified.`,
        `Incident ID: #${incidentId}`,
        ``,
        `View incident in dashboard: ${dashboardLink}`,
      ].join('\n');

      const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b0f19; color: #f3f4f6; padding: 24px;">
  <div style="max-width: 600px; margin: 0 auto; background: #131b2e; border: 1px solid #16a34a; border-radius: 8px; padding: 24px;">
    <div style="display: flex; align-items: center; margin-bottom: 16px;">
      <span style="background: #16a34a; color: white; padding: 4px 10px; border-radius: 4px; font-weight: bold; font-size: 13px; text-transform: uppercase;">Incident Resolved</span>
      <span style="color: #9ca3af; margin-left: 12px; font-size: 14px;">Incident #${escHtml(incidentId)}</span>
    </div>
    <h2 style="margin: 0 0 12px 0; color: #ffffff; font-size: 20px;">${escHtml(monitorName)} is HEALTHY</h2>
    <p style="color: #9ca3af; font-size: 14px; margin: 0 0 16px 0;">The monitor completed 2 consecutive successful health checks.</p>
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 14px;">
      <tr><td style="padding: 8px 0; color: #9ca3af; width: 140px;">Endpoint:</td><td style="padding: 8px 0; color: #f3f4f6; font-family: monospace;">${escHtml(monitorUrl)}</td></tr>
      <tr><td style="padding: 8px 0; color: #9ca3af;">Resolved At:</td><td style="padding: 8px 0; color: #f3f4f6;">${escHtml(resolvedAt)}</td></tr>
      <tr><td style="padding: 8px 0; color: #9ca3af;">Status:</td><td style="padding: 8px 0; color: #22c55e; font-weight: 500;">All configured assertions passed</td></tr>
    </table>
    <a href="${escHtml(dashboardLink)}" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; font-size: 14px;">View Incident in Dashboard</a>
  </div>
</body>
</html>`;

      return { subject, text, html };
    }
  }

  /**
   * Sends an incident email notification to specified recipients.
   *
   * @param {Object} params
   * @param {Array<string>} params.recipients
   * @param {string} params.eventType - 'incident_opened' | 'incident_resolved'
   * @param {Object} params.payload
   * @returns {Promise<Object>}
   */
  async sendIncidentEmail({ recipients, eventType, payload }) {
    const transporter = this.getTransporter();
    if (!transporter) {
      throw new Error('SMTP transport is not configured');
    }

    if (!recipients || recipients.length === 0) {
      return { skipped: true, reason: 'NO_RECIPIENTS' };
    }

    const { subject, text, html } = this.buildEmailContent({
      eventType,
      payload,
      appOrigin: this.config.appOrigin || 'http://localhost:5000',
    });

    const mailOptions = {
      from: this.config.smtp.from,
      to: recipients.join(', '),
      subject,
      text,
      html,
    };

    const deadlineMs = (this.config.smtp && this.config.smtp.deliveryDeadlineMs) || 30000;

    let deadlineTimer = null;
    const deadlinePromise = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => {
        const err = new Error(`SMTP_DELIVERY_TIMEOUT: Email delivery attempt exceeded hard wall-clock deadline of ${deadlineMs}ms`);
        err.code = 'ETIMEDOUT';
        // Abort the transporter connection immediately to destroy sockets
        if (transporter && typeof transporter.close === 'function') {
          try {
            transporter.close();
          } catch (_e) {
            // ignore close error
          }
        }
        reject(err);
      }, deadlineMs);
      if (deadlineTimer && typeof deadlineTimer.unref === 'function') {
        deadlineTimer.unref();
      }
    });

    try {
      const info = await Promise.race([
        transporter.sendMail(mailOptions),
        deadlinePromise,
      ]);
      clearTimeout(deadlineTimer);

      this.logger.info(
        { messageId: info.messageId, recipientCount: recipients.length, eventType, incidentId: payload.incident_id },
        'Incident notification email sent'
      );

      return {
        success: true,
        messageId: info.messageId,
        accepted: info.accepted,
      };
    } catch (err) {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
      }
      throw err;
    }
  }
}

const emailService = new EmailService();

module.exports = {
  EmailService,
  emailService,
  escHtml,
};

