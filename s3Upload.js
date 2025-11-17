const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const config = require('../config/common.config');

// Replace with your actual DigitalOcean Spaces credentials and region
const accessKeyId = atob(config.AWS_S3.accessKeyId);
const secretAccessKey = atob(config.AWS_S3.secretAccessKey);
const region = config.AWS_S3.region; // e.g., 'nyc3'
const bucketName = config.AWS_S3.bucketName;


const s3Client = new S3Client({
    credentials: {
        accessKeyId,
        secretAccessKey,
    },
    region,
    endpoint: `https://${config.AWS_S3.region}.digitaloceanspaces.com`
});

exports.uploadS3Media = async function (filePath, newFileName = "test.png") {
    let uploadPromise = new Promise(async (resolve, reject) => {
        if (config.AWS_S3.enabled) {
            // Read the video file
            const fileContent = fs.readFileSync(filePath);

            // Set the parameters for the S3 upload
            const params = {
                Bucket: bucketName,
                Key: newFileName, // The name you want to give to your file in the bucket
                Body: fileContent,
                ACL: 'public-read'
            };
            try {
                const data = await s3Client.send(new PutObjectCommand(params));

                // fs.unlink(filePath, (err) => {
                //     if (err) {
                //         console.error(err);
                //     }
                //     console.log('public file removed');
                // });

                console.log('Video uploaded successfully. S3 URL:', data);

            } catch (error) {
                console.log('error-->>>>', error);

            }
            resolve();
        }
        else {
            resolve();
        }

    })
    await uploadPromise;
};


exports.deleteS3Media = async function (filePath) {
    let uploadPromise = new Promise((resolve, reject) => {
        if (config.AWS_S3.enabled) {

            // Set the parameters
            const params = {
                Bucket: bucketName,
                Key: filePath,
            };

            s3.deleteObject(params, (err, data) => {
                if (err) {
                    resolve();
                    console.error('Error deleting video:', err);
                } else {
                    resolve(data);
                    console.log('Video deleted successfully:', data);
                }
            });
        }
        else {
            resolve();
        }

    })
    await uploadPromise;
};