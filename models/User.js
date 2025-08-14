// model/User.js
const mongoose = require('mongoose');

/*const User = mongoose.model('User', {
  name: { type: String, required: [true, 'Name is required'] },
  email: { type: String, required: [true, 'Email is required'], unique: true },
  age: { type: Number, default: 0 }
});*/

//module.exports = User;


const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    age: { type: Number, default: 0 },
    password: { type: String, required: true } // new field
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);

