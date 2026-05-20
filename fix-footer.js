const fs = require('fs');
const path = '/opt/polsia/workspaces/company-75550/agent-30/exec-2055496/buildorbit/public/index.html';
const content = fs.readFileSync(path, 'utf8');

const oldFooter = `    <!-- ── Footer ────────────────────────────────────────── -->
    <footer>
        <div class=\"footer-pipeline\">
            <span>Intent Gate</span>
            <span class=\"arrow\">→</span>
            <span>Plan</span>
            <span class=\"arrow\">→</span>
            <span>Scaffold</span>
            <span class=\"arrow\">→</span>
            <span>Code</span>
            <span class=\"arrow\">→</span>
            <span>Save</span>
            <span class=\"arrow\">→</span>
            <span>Verify</span>
        </div>
        <p>BuildOrbit &mdash; The glass-box pipeline.</p>
    </footer>`;

const newFooter = `    <!-- ── Footer ────────────────────────────────────────── -->
    <footer class=\"site-footer\">
        <div class=\"footer-inner\">
            <!-- Brand column -->
            <div class=\"footer-brand\">
                <div class=\"footer-logo\">
                    <div class=\"footer-logo-dot\"></div>
                    BuildOrbit
                </div>
                <p class=\"footer-tagline\">The glass-box pipeline.<br>AI that explains itself.</p>
            </div>

            <!-- Link columns -->
            <div class=\"footer-links\">
                <div class=\"footer-col\">
                    <div class=\"footer-col-heading\">Product</div>
                    <a href=\"#\" class=\"footer-link\">Pipeline</a>
                    <a href=\"#\" class=\"footer-link\">Pricing</a>
                    <a href=\"/dashboard\" class=\"footer-link\">Dashboard</a>
                    <a href=\"#\" class=\"footer-link\">API</a>
                </div>

                <div class=\"footer-col\">
                    <div class=\"footer-col-heading\">Solutions</div>
                    <a href=\"#\" class=\"footer-link\">Enterprise</a>
                    <a href=\"#\" class=\"footer-link\">Legal</a>
                    <a href=\"#\" class=\"footer-link\">Finance</a>
                    <a href=\"#\" class=\"footer-link\">Healthcare</a>
                </div>

                <div class=\"footer-col\">
                    <div class=\"footer-col-heading\">Company</div>
                    <a href=\"#\" class=\"footer-link\">About</a>
                    <a href=\"#\" class=\"footer-link\">Careers</a>
                    <a href=\"#\" class=\"footer-link\">Terms</a>
                    <a href=\"#\" class=\"footer-link\">Privacy</a>
                </div>

                <div class=\"footer-col\">
                    <div class=\"footer-col-heading\">Resources</div>
                    <a href=\"#\" class=\"footer-link\">Docs</a>
                    <a href=\"#\" class=\"footer-link\">Blog</a>
                    <a href=\"#\" class=\"footer-link\">Case Studies</a>
                </div>
            </div>
        </div>

        <div class=\"footer-bottom\">
            <div class=\"footer-bottom-left\">
                <span class=\"footer-pipeline-mono\">Intent Gate</span>
                <span class=\"footer-arrow\">→</span>
                <span class=\"footer-pipeline-mono\">Plan</span>
                <span class=\"footer-arrow\">→</span>
                <span class=\"footer-pipeline-mono\">Scaffold</span>
                <span class=\"footer-arrow\">→</span>
                <span class=\"footer-pipeline-mono\">Code</span>
                <span class=\"footer-arrow\">→</span>
                <span class=\"footer-pipeline-mono\">Save</span>
                <span class=\"footer-arrow\">→</span>
                <span class=\"footer-pipeline-mono\">Verify</span>
            </div>
            <div class=\"footer-bottom-right\">
                <span class=\"footer-copy\">© 2026 BuildOrbit</span>
            </div>
        </div>
    </footer>`;

if (content.includes(oldFooter)) {
    const newContent = content.replace(oldFooter, newFooter);
    fs.writeFileSync(path, newContent);
    console.log('SUCCESS: Footer replaced');
} else {
    console.log('FAILED: Old footer not found in content');
    const idx = content.indexOf('<!-- ── Footer');
    if (idx >= 0) {
        console.log('Footer comment found at index:', idx);
        console.log('Content:', JSON.stringify(content.slice(idx, idx + 600)));
    } else {
        console.log('Footer comment not found');
    }
}