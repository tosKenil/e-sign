const axios = require('axios');
async function sendMail(to, subject, body) {
    try {
        const response = await axios.post(
            'https://api.brevo.com/v3/smtp/email',
            {
                sender: { name: process.env.FROM_NAME, email: process.env.FROM_EMAIL },
                to: [{ email: to }],
                subject,
                htmlContent: body,
            },
            {
                headers: {
                    'api-key': process.env.BREVO_API_KEY,
                    'Content-Type': 'application/json',
                },
            }
        );
        console.log("🚀 ~ sendMail ~ response.data:", response.data)
        return response.data;
    } catch (error) {
        console.log("🚀 ~ sendMail ~ error:", error.message)
        throw error;
    }
}

module.exports = sendMail;