const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  phoneNumber: {
    type: String,
    required: true,
    unique: true,
  },
  whatsappName: {
    type: String,
  },
  walletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Wallet',
  },
  contacts: [{
    alias: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    publicKey: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  }],
  pendingSend: {
    amount: String,
    destination: String,
    alias: String,
    requestedAt: Date,
  }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
