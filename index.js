const express = require("express");
const app = express();
const port = process.env.PORT || 5000;
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.PAYMENT_SECRECT);
const crypto = require("crypto");

// Firebase
const admin = require("firebase-admin");

const decoded = Buffer.from(
  process.env.FIREBASE_SERVICE_KEY,
  "base64"
).toString("utf8");
const serviceAccount = JSON.parse(decoded);

// const serviceAccount = require("./zap-shipt-2025-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Function to generate tracking ID
function generateTrackingId() {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const randomPart = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6 chars
  return `PRCL-${dateStr}-${randomPart}`;
}

//Middle Ware
app.use(cors());
app.use(express.json());

// verify
const verifyFBToken = async (req, res, next) => {
  // console.log("in the middleWarre rahat", req.headers);

  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: "Unauthorize Access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorize Access" });
  }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@simplecrud.h04rjld.mongodb.net/?appName=SimpleCrud`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
   
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );

    // Crud Operaction
    const db = client.db("zap_shift_db");
    const usersCollection = db.collection("users");
    const ridersCollection = db.collection("riders");
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");

    // Verify Adimn
    // must be use after verifyfbtoken
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;

      const query = { email };

      const user = await usersCollection.findOne(query);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "UnAuthorized Access" });
      }

      next();
    };

    // User ralated APis
    app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
      const { searchText } = req.query;
      const query = {};

      if (searchText) {
        // query.displayName = {$regex : searchText, $options: 'i'};

        query.$or = [
          { displayName: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }

      const cursor = usersCollection.find(query).sort({ created_At: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/users/:email/role", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      const email = user.email;
      const userExist = await usersCollection.findOne({ email });
      if (userExist) {
        return res.send({ message: "User Already Exist" });
      }

      user.role = "user";
      user.created_At = new Date();
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.patch("/users/:id", async (req, res) => {
      const id = req.params.id;
      const userRole = req.body.role;
      const query = { _id: new ObjectId(id) };
      const updateInfo = {
        $set: {
          role: userRole,
        },
      };

      const result = await usersCollection.updateOne(query, updateInfo);
      res.send(result);
    });

    // Rider Related Apis

    app.get("/riders", verifyFBToken, verifyAdmin, async (req, res) => {
      const query = {};

      if (req.query.status) {
        query.status = req.query.status;
      }
      const cursor = ridersCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    // FInd Avaiable Rider by district
    app.get(`/riders/available`, verifyFBToken, async (req, res) => {
      const { workStatus, district, status } = req.query;
      const query = { workStatus, district, status };
      const cursor = ridersCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.post("/riders", verifyFBToken, async (req, res) => {
      const riderInfo = req.body;
      const email = riderInfo.email;

      const query = { email: email };

      const existingApplication = await ridersCollection.findOne(query);
      if (existingApplication) {
        return res.send({ message: "Application Already Done." });
      }

      riderInfo.status = "pending";
      riderInfo.created_At = new Date();

      const result = await ridersCollection.insertOne(riderInfo);
      res.send(result);
    });

    app.patch("/riders/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const status = req.body.status;
      const updatedDocs = {
        $set: {
          status: status,
        },
      };

      // status update 
      const result = await ridersCollection.updateOne(query, updatedDocs);

      if (status === "approved") {
        const email = req.body.email;
        const userQuery = { email: email };

        // Update user
        const updateUser = {
          $set: {
            role: "rider",
            workStatus: "available",
          },
        };
        const result = await usersCollection.updateOne(userQuery, updateUser);
      }

      res.send(result);
    });

    //   Parcel Api
    app.get("/parcels", verifyFBToken, async (req, res) => {
      const query = {};
      const { email, deliveryStatus } = req.query;
      const decodedEmail = req.decoded_email;

      // if (email !== decodedEmail) {
      //   return res.status(401).send({ message: "UnAuthorize Access" });
      // }

      if (email) {
        query.senderEmail = email;
      }

      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }

      const options = { sort: { created_At: -1 } };
      const cursor = parcelsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });

    app.post("/parcels", verifyFBToken, async (req, res) => {
      const newParcel = req.body;
      newParcel.created_At = new Date();
      const result = await parcelsCollection.insertOne(newParcel);
      res.send(result);
    });

    app.patch("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const { riderId, riderName, riderEmail } = req.body;
      const query = { _id: new ObjectId(id) };

      // Parcel update
      const updatedDoc = {
        $set: {
          riderId,
          riderName,
          riderEmail,
          deliveryStatus: "rider-assigned",
        },
      };

      const parcelResult = await parcelsCollection.updateOne(query, updatedDoc);

      // Update work Info

      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdateInfo = {
        $set: {
          workStatus: "on-delivery",
        },
      };
      const result = await ridersCollection.updateOne(
        riderQuery,
        riderUpdateInfo
      );

      res.send(result);
    });

    app.delete("/parcels/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });

    // Payment Related Apis

    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              },
            },

            quantity: 1,
          },
        ],
        mode: "payment",
        customer_email: paymentInfo.senderEmail,
        metadata: {
          parcelId: paymentInfo.parcelId,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancel`,
      });

      console.log(session);
      res.send({ url: session.url });
    });

    // My Build
    app.post("/payment-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: `Please Pay for :  ${paymentInfo.parcelName}`,
              },
            },
            quantity: 1,
          },
        ],

        mode: "payment",
        customer_email: paymentInfo.senderEmail,
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName || "Unnamed Parcel",
        },

        // url
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancel`,
      });

      res.send({ url: session.url });
    });



    

    // Validate Payment
    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(
        req.query.session_id
      );
      console.log(session);
      const transitionId = session.payment_intent;
      const query = { transitionId: transitionId };

      const paymentExist = await paymentsCollection.findOne(query);
      console.log(paymentExist);
      if (paymentExist) {
        return res.send({
          message: "Already Payment Exist",
          transitionId,
          trackingId: paymentExist.trackingId,
        });
      }

      const trackingId = generateTrackingId();
      console.log("payment status", session);
      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            deliveryStatus: "pending-pickup",
            trackingId: trackingId,
          },
        };

        const result = await parcelsCollection.updateOne(query, update);

        const payment = {
          amount: session.amount_total,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transitionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };

        if (session.payment_status === "paid") {
          const resultPayment = await paymentsCollection.insertOne(payment);
          return res.send({
            success: true,
            modifyParcel: result,
            trackingId: trackingId,
            transitionId: session.payment_intent,
            paymentInfo: resultPayment,
          });
        }
      }
    });

    // Payments Related Apis
    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};
      if (email) {
        query.customerEmail = email;

        // Check Email Addreess

        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "Forbiden Access" });
        }
      }

      const cursor = paymentsCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    // Payments Related Apis
    app.get("/all-payments", verifyFBToken, verifyAdmin, async (req, res) => {
      console.log("in the all payments", req.decoded_email);
      const cursor = paymentsCollection.find().sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Your Server Is Running");
});

app.listen(port, () => {
  console.log("Your Server Running Port : ", port);
});
