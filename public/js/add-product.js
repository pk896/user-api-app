document.addEventListener("DOMContentLoaded", () => {
  console.log("✅ add-product.js loaded successfully");

  const form = document.getElementById("productForm");
  const fileInput = document.getElementById("imageFile");
  const previewWrapper = document.getElementById("imagePreviewWrapper");
  const previewImg = document.getElementById("imagePreview");

  // ✅ Image preview setup
  if (fileInput && previewWrapper && previewImg) {
    fileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return (previewWrapper.style.display = "none");
      const reader = new FileReader();
      reader.onload = (ev) => {
        previewWrapper.style.display = "block";
        previewImg.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ✅ Form submission
  if (!form) return console.error("❌ No #productForm found!");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    console.log("📤 Submitting product form...");

    const formData = new FormData(form);

    try {
      const response = await fetch("/products/add", {
        method: "POST",
        body: formData,
      });

      console.log("➡️ Response status:", response.status);
      const text = await response.text();
      console.log("📦 Response text:", text);

      if (response.ok) {
        alert("✅ Product added successfully!");
        window.location.href = "/products/manage";
      } else {
        alert("❌ Failed to add product.\n\n" + text);
      }
    } catch (err) {
      console.error("❌ Network or fetch error:", err);
      alert("⚠️ Network error while uploading.");
    }
  });
});
