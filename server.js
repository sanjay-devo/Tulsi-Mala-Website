const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const Razorpay = require('razorpay');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// ============ CONFIGURATION ============

// Razorpay Credentials
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,        // rzp_live_SO0ZFBCZTJT9Tu
    key_secret: process.env.RAZORPAY_KEY_SECRET  // Your Key Secret
});

// Firebase Admin Setup
const serviceAccount = require('./firebase-key.json'); // Download from Firebase Console

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://tulsi-mala-default-rtdb.firebaseio.com"
});

const db = admin.database();

// ============ ROUTES ============

// 1. CREATE ORDER (Frontend calls this)
app.post('/api/create-order', async (req, res) => {
    try {
        const { product, customer_name, customer_phone, address, customizations, total_amount } = req.body;

        // Validation
        if (!product || !customer_name || !customer_phone || !address || !total_amount) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }

        if (customer_phone.length !== 10) {
            return res.status(400).json({ success: false, message: "Invalid phone number" });
        }

        // Create Razorpay Order
        const razorpayOrder = await razorpay.orders.create({
            amount: total_amount * 100, // Amount in paise
            currency: "INR",
            receipt: `order_${Date.now()}`,
            payment_capture: 1, // Auto-capture enabled
            notes: {
                product: product,
                customer_name: customer_name,
                customer_phone: customer_phone,
                address: address,
                customizations: JSON.stringify(customizations)
            }
        });

        // Save to Firebase with Razorpay Order ID
        const firebaseRef = db.ref('orders').push();
        await firebaseRef.set({
            product: product,
            customer_name: customer_name,
            customer_phone: customer_phone,
            address: address,
            customizations: customizations,
            total_amount: total_amount,
            razorpay_order_id: razorpayOrder.id,
            payment_status: "Pending",
            timestamp: new Date().toISOString()
        });

        res.json({
            success: true,
            razorpay_order_id: razorpayOrder.id,
            firebase_order_id: firebaseRef.key,
            key_id: process.env.RAZORPAY_KEY_ID
        });

    } catch (error) {
        console.error('Order Creation Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. VERIFY PAYMENT (Frontend calls this after payment)
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, firebase_order_id } = req.body;

        // Verify Razorpay Signature
        const hmac = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(razorpay_order_id + "|" + razorpay_payment_id)
            .digest('hex');

        if (hmac !== razorpay_signature) {
            return res.status(400).json({ success: false, message: "Invalid payment signature" });
        }

        // Fetch Payment Details from Razorpay
        const payment = await razorpay.payments.fetch(razorpay_payment_id);

        // Update Firebase with Payment Status
        const orderRef = db.ref(`orders/${firebase_order_id}`);
        await orderRef.update({
            payment_status: "Paid",
            razorpay_payment_id: razorpay_payment_id,
            razorpay_signature: razorpay_signature,
            payment_method: payment.method,
            payment_timestamp: new Date().toISOString(),
            captured: payment.captured
        });

        res.json({
            success: true,
            message: "Payment verified successfully",
            captured: payment.captured
        });

    } catch (error) {
        console.error('Payment Verification Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 3. GET ORDER STATUS
app.get('/api/order-status/:orderId', async (req, res) => {
    try {
        const orderRef = db.ref(`orders/${req.params.orderId}`);
        const snapshot = await orderRef.once('value');
        
        if (!snapshot.exists()) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        res.json({
            success: true,
            order: snapshot.val()
        });

    } catch (error) {
        console.error('Order Status Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 4. WEBHOOK FOR RAZORPAY (For real-time updates if needed)
app.post('/api/razorpay-webhook', async (req, res) => {
    try {
        const event = req.body.event;
        const data = req.body.payload.payment.entity;

        console.log('Webhook Event:', event);

        if (event === 'payment.authorized' || event === 'payment.captured') {
            // Auto-capture is already handled, this is just for logging
            console.log('Payment Captured:', data.id);
        }

        res.json({ success: true });

    } catch (error) {
        console.error('Webhook Error:', error);
        res.status(500).json({ success: false });
    }
});

// 5. HEALTH CHECK
app.get('/api/health', (req, res) => {
    res.json({ success: true, message: "Server is running" });
});

// ============ START SERVER ============
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log('🔐 Razorpay Auto-Capture: ENABLED');
});

module.exports = app;
