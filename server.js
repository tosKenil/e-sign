// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const mime = require("mime-types");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const ejs = require("ejs");
const { SIGN_EVENTS } = require("./contance.js"); // { PENDING,SENT,DELIVERED,COMPLETED,VOIDED }
const sendMail = require("./sendmail.js");

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(cors({
    origin: [
        "http://localhost:3000",
        "https://e-sign-delta.vercel.app/", // change this
        "https://e-sign-delta.vercel.app" // change this
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true
}));

// -------------------- ENV CONFIG --------------------
const PORT = process.env.PORT || 4011;
const BASE_URL = process.env.BASE_URL || `https://e-sign-delta.vercel.app`;
const JWT_SECRET = process.env.JWT_SECRET || "supersecret";
const expireTime = { expiresIn: "5m" };
const IS_PROD = process.env.VERCEL === "1" || process.env.NODE_ENV === "production";

// -------------------- STORAGE PATHS --------------------
const STORAGE_DIR = IS_PROD ? "/tmp/storage" : path.join(__dirname, "storage");
const ORIGINALS_DIR = path.join(STORAGE_DIR, "originals");
const SIGNED_DIR = path.join(STORAGE_DIR, "signed");

(async () => {
    await fsp.mkdir(ORIGINALS_DIR, { recursive: true });
    await fsp.mkdir(SIGNED_DIR, { recursive: true });
})();

// -------------------- DATABASE --------------------
mongoose
    .connect(process.env.DB_URL)
    .then(() => console.log("✅ MongoDB connected"))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });

// -------------------- SCHEMA (multi-signer) --------------------
const originalFileSchema = new mongoose.Schema(
    { filename: String, storedName: String, publicUrl: String, mimetype: String },
    { _id: false }
);

const signerSchema = new mongoose.Schema(
    {
        email: { type: String, required: true },
        name: { type: String, default: "" },
        status: {
            type: String,
            enum: [
                SIGN_EVENTS.PENDING,
                SIGN_EVENTS.SENT,
                SIGN_EVENTS.DELIVERED,
                SIGN_EVENTS.COMPLETED,
                SIGN_EVENTS.VOIDED
            ],
            default: SIGN_EVENTS.PENDING
        },
        sentAt: Date,
        deliveredAt: Date,
        completedAt: Date,
        signedUrl: String,
    },
    { _id: false }
);

const envelopeSchema = new mongoose.Schema(
    {
        signers: [signerSchema],
        documentStatus: {
            type: String,
            enum: [
                SIGN_EVENTS.PENDING,
                SIGN_EVENTS.SENT,
                SIGN_EVENTS.DELIVERED,
                SIGN_EVENTS.VOIDED,
                SIGN_EVENTS.COMPLETED
            ],
            default: SIGN_EVENTS.PENDING
        },
        files: [originalFileSchema],
        pdf: { type: String, default: "" },
        signedPdf: { type: String, default: "" }, // final merged/fully-signed pdf (optional)
        signedUrl: { type: String, default: "" }, // convenience: first signer link
    },
    { collection: "envelope", timestamps: true }
);

const Envelope = mongoose.model("envelope", envelopeSchema);

// -------------------- HELPERS --------------------
function generateId() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// expects tokens we issue as: { envId, email, i }
function verifyJWT(req, res, next) {
    const token = req.params.token;
    if (!token) return res.status(401).json({ error: "Missing token" });
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ error: "Invalid token" });
        // decoded: { envId, email, i, iat, exp }
        req.envId = decoded.envId || decoded._id; // _id fallback if you ever used older tokens
        req.signerEmail = decoded.email;
        req.signerIndex = typeof decoded.i === "number" ? decoded.i : undefined;
        next();
    });
}

// -------------------- STATIC --------------------
app.use("/storage", express.static(STORAGE_DIR, { fallthrough: true }));
app.use("/form", express.static(path.join(__dirname, "web/form")));
app.use("/web", express.static(path.join(__dirname, "web")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "web", "form.html"));
});

// -------------------- MULTER (signed PDF upload) --------------------
const uploadSignedFile = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            cb(null, SIGNED_DIR);
        },
        filename: (req, file, cb) => {
            const uniqueName = `${Date.now()}-${generateId()}.pdf`;
            cb(null, uniqueName);
        },
    }),
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext !== ".pdf") return cb(new Error("Only PDF files allowed"));
        cb(null, true);
    },
});

// -------------------- ROUTES --------------------

// ---- Generate ONE envelope with MULTIPLE signers ----
app.post("/api/generate-template", uploadSignedFile.none(), async (req, res) => {
    console.log("🚀 ~ POST /api/generate-template (single envelope, multi-signers)");
    try {
        const { templates, emails, name, address, company_name, uen, reg_address, date } = req.body;

        // Parse templates
        let selected;
        try {
            selected = JSON.parse(templates);
        } catch {
            selected = String(templates || "")
                .split(/[,\s]+/)
                .map((s) => s.trim())
                .filter(Boolean);
        }
        if (!Array.isArray(selected) || selected.length === 0) {
            return res.status(400).json({ error: "Select at least one template" });
        }

        // Parse recipients => [{email,name}]
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        function parseRecipients(input) {
            let list;
            try {
                const parsed = JSON.parse(input);
                if (Array.isArray(parsed)) {
                    list = parsed
                        .map((v) => {
                            if (typeof v === "string") return v;
                            if (v && typeof v === "object" && v.email) return `${v.name || ""} <${v.email}>`;
                            return null;
                        })
                        .filter(Boolean);
                } else {
                    list = [];
                }
            } catch {
                list = String(input || "").split(/[\n,;]+/);
            }

            const uniq = new Map(); // email -> {email,name}
            for (let raw of list) {
                raw = String(raw || "").trim();
                if (!raw) continue;

                // "Name <email>" or plain "email"
                let m = raw.match(/^(.*)<([^>]+)>$/);
                let recName = "";
                let recEmail = raw;
                if (m) {
                    recName = m[1].trim().replace(/^"|"$/g, "");
                    recEmail = m[2].trim();
                }
                recEmail = recEmail.toLowerCase();
                if (!emailRegex.test(recEmail)) continue;

                if (!uniq.has(recEmail)) {
                    uniq.set(recEmail, { email: recEmail, name: recName });
                }
            }

            return Array.from(uniq.values());
        }

        const recipients = parseRecipients(emails);
        if (recipients.length === 0) {
            return res.status(400).json({ error: "Provide at least one valid recipient email" });
        }

        // Generate all requested HTML files ONCE
        const files = [];
        for (const type of selected) {
            const tplPath = path.join(__dirname, "templates", `${type}.html`);
            if (!fs.existsSync(tplPath)) continue;

            const raw = await fsp.readFile(tplPath, "utf8");
            const html = ejs.render(raw, {
                name,
                address,
                reg_address,
                company_name,
                uen,
                date,
            });

            const fileName = `${Date.now()}-${generateId()}-${type}.html`;
            const outPath = path.join(ORIGINALS_DIR, fileName);
            await fsp.writeFile(outPath, html);

            files.push({
                filename: fileName,
                storedName: fileName,
                publicUrl: `${BASE_URL}/storage/originals/${fileName}`,
                mimetype: "text/html",
            });
        }

        if (files.length === 0) {
            return res.status(404).json({ error: "No templates found" });
        }

        // Build signers array (SENT)
        const now = new Date();
        const signers = recipients.map((r) => ({
            email: r.email,
            name: r.name || name || "",
            status: SIGN_EVENTS.SENT,
            sentAt: now,
            deliveredAt: undefined,
            completedAt: undefined,
            signedUrl: "",
        }));

        // Create ONE envelope
        let env = await Envelope.create({
            signers,
            documentStatus: SIGN_EVENTS.SENT,
            files,
            pdf: "",
            signedPdf: "",
            signedUrl: "",
        });

        // Generate a unique token/link PER signer
        const signerResults = [];
        for (let i = 0; i < env.signers.length; i++) {
            const s = env.signers[i];
            const tokenPayload = { envId: String(env._id), email: s.email, i };
            const token = jwt.sign(tokenPayload, JWT_SECRET);
            const signerUrl = `${BASE_URL}/sign/${token}`;

            env.signers[i].signedUrl = signerUrl;
            signerResults.push({ email: s.email, name: s.name, signedUrl: signerUrl });
        }

        // Convenience: first signer link
        env.signedUrl = signerResults[0]?.signedUrl || "";
        await env.save();

        // Email each signer their link
        await Promise.all(
            signerResults.map(async ({ email, name: nm, signedUrl }) => {
                const subject = `Documents ready for signature`;
                const bodyHtml = `
          <p>Hi ${nm || name || ""},</p>
          <p>Your documents are ready to sign. Click the link below:</p>
          <p><a href="${signedUrl}" target="_blank" rel="noopener">Sign Documents</a></p>
          <p>If you didn’t expect this email, you can ignore it.</p>
        `;
                await sendMail(email, subject, bodyHtml);
            })
        );

        // Response
        res.json({
            ok: true,
            envelopeId: String(env._id),
            envelopeSignUrl: env.signedUrl,
            documentStatus: env.documentStatus,
            files: env.files.map((f) => ({ filename: f.filename, publicUrl: f.publicUrl, mimetype: f.mimetype })),
            signers: env.signers.map((s) => ({
                email: s.email,
                name: s.name,
                status: s.status,
                sentAt: s.sentAt,
                signedUrl: s.signedUrl,
            })),
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Generation failed" });
    }
});

// --- Read envelope by token (marks DELIVERED for this signer on first open) ---
app.get("/api/envelopes/by-token/:token", verifyJWT, async (req, res) => {
    console.log("/api/envelopes/by-token/:token")
    const env = await Envelope.findById(req.envId);
    if (!env) return res.status(404).json({ error: "Envelope not found" });

    // find signer by index or email
    let idx = typeof req.signerIndex === "number" ? req.signerIndex : env.signers.findIndex(s => s.email === req.signerEmail);
    if (idx < 0 || idx >= env.signers.length) {
        return res.status(400).json({ error: "Signer not found in envelope" });
    }

    // mark DELIVERED if not already
    if (env.signers[idx].status === SIGN_EVENTS.SENT) {
        env.signers[idx].status = SIGN_EVENTS.DELIVERED;
        env.signers[idx].deliveredAt = new Date();
        // optional: if all signers delivered, bump envelope to DELIVERED
        if (env.signers.every(s => [SIGN_EVENTS.DELIVERED, SIGN_EVENTS.COMPLETED].includes(s.status))) {
            env.documentStatus = SIGN_EVENTS.DELIVERED;
        }
        await env.save();
    }

    res.json({
        envelopeId: String(env._id),
        documentStatus: env.documentStatus,
        signer: {
            index: idx,
            email: env.signers[idx].email,
            name: env.signers[idx].name,
            status: env.signers[idx].status,
            sentAt: env.signers[idx].sentAt,
            deliveredAt: env.signers[idx].deliveredAt,
            completedAt: env.signers[idx].completedAt,
        },
        files: env.files.map((f) => ({
            url: f.publicUrl,
            mimetype: f.mimetype,
        })),
    });
});

app.get("/api/test", async (req, res) => {
    res.json({ ok: true, message: "Test endpoint working" });
});

// --- Complete (upload signed pdf) for THIS signer ---
app.post("/api/envelopes/:token/complete", verifyJWT, uploadSignedFile.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "Missing file in upload" });
        }

        const env = await Envelope.findById(req.envId);
        if (!env) return res.status(404).json({ error: "Envelope not found" });

        // find signer by index or email
        let idx = typeof req.signerIndex === "number" ? req.signerIndex : env.signers.findIndex(s => s.email === req.signerEmail);
        if (idx < 0 || idx >= env.signers.length) {
            return res.status(400).json({ error: "Signer not found in envelope" });
        }

        // update this signer to COMPLETED
        env.signers[idx].status = SIGN_EVENTS.COMPLETED;
        env.signers[idx].completedAt = new Date();

        // store/replace envelope-level signed PDF (you can also store per-signer if you want another field)
        env.signedPdf = `${BASE_URL}/storage/signed/${req.file.filename}`;

        // if ALL completed -> envelope COMPLETED
        if (env.signers.every(s => s.status === SIGN_EVENTS.COMPLETED)) {
            env.documentStatus = SIGN_EVENTS.COMPLETED;
        }

        await env.save();

        res.json({
            ok: true,
            downloadUrl: env.signedPdf,
            envelopeId: String(env._id),
            signerIndex: idx,
            signerEmail: env.signers[idx].email,
            documentStatus: env.documentStatus,
        });
    } catch (err) {
        console.error("Error in /api/envelopes/:token/complete", err && err.stack ? err.stack : err);
        res.status(500).json({ error: err?.message || "Upload failed" });
    }
});

// --- Cancel (void) envelope ---
app.post("/api/envelopes/:token/cancel", verifyJWT, async (req, res) => {
    const env = await Envelope.findById(req.envId);
    if (!env) return res.status(404).json({ error: "Envelope not found" });

    env.documentStatus = SIGN_EVENTS.VOIDED;
    env.signers = env.signers.map(s => ({ ...s.toObject(), status: SIGN_EVENTS.VOIDED }));
    await env.save();

    res.json({ ok: true, message: "Cancelled", envelopeId: String(env._id) });
});

// --- Serve signing page ---
app.get("/sign/:token", (req, res) => {
    jwt.verify(req.params.token, JWT_SECRET, (err) => {
        if (err) return res.status(401).send("Link expired");
        res.sendFile(path.join(__dirname, "web", "sign.html"));
    });
});

// --- Global error handler ---
app.use((err, req, res, next) => {
    if (!err) return next();
    console.error("Unhandled error middleware caught:", err && err.stack ? err.stack : err);
    const message = err.message || (err.code ? String(err.code) : "Server error");
    res.status(500).json({ error: message });
});

// -------------------- START --------------------
if (require.main === module) {
    app.listen(PORT, () => console.log(`🚀 Server running at ${BASE_URL}`));
}

module.exports = app;
