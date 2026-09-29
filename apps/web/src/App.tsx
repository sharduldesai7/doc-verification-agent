import { NavLink, Route, Routes } from "react-router-dom";
import { ReferenceDataPage } from "./pages/ReferenceDataPage";
import { ReviewDetailPage } from "./pages/ReviewDetailPage";
import { ReviewListPage } from "./pages/ReviewListPage";
import { StatusPage } from "./pages/StatusPage";
import { SubmitPage } from "./pages/SubmitPage";

export function App() {
  return (
    <>
      <header className="topbar">
        <NavLink to="/" className="brand">Income Verification</NavLink>
        <nav>
          <NavLink to="/" end>Submit</NavLink>
          <NavLink to="/review">Review</NavLink>
          <NavLink to="/reference-data">Reference data</NavLink>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<SubmitPage />} />
          <Route path="/status/:id" element={<StatusPage />} />
          <Route path="/review" element={<ReviewListPage />} />
          <Route path="/review/:id" element={<ReviewDetailPage />} />
          <Route path="/reference-data" element={<ReferenceDataPage />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
      <footer className="note">
        Demo build: no authentication. Do not use with real applicant documents.
      </footer>
    </>
  );
}
